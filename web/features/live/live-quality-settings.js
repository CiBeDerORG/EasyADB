// Device preferences are page-local; wire payload keys deliberately remain snake_case.
export function createLiveQualitySettings({ documentRef }) {
  const make = (tag, cls = '', label) => {
    const element = documentRef.createElement(tag);
    if (cls) element.className = cls;
    if (label !== undefined) element.textContent = label;
    return element;
  };
  const CHOICES = [
    ['economy', '省流 · 960 / 3 Mbps / 24 FPS'],
    ['baseline', '基础 · 1600 / 8 Mbps / 30 FPS'],
    ['native', '原生 · 不限制尺寸 / 16 Mbps / 30 FPS'],
    ['custom', '自定义'],
  ];
  const EXPERIMENTAL_RESOLUTIONS = [
    ['2560x1440', '2560 × 1440'],
    ['1920x1440', '1920 × 1440'],
    ['1920x1200', '1920 × 1200'],
    ['1920x1080', '1920 × 1080'],
    ['1680x1050', '1680 × 1050'],
    ['1600x1200', '1600 × 1200'],
    ['1600x1024', '1600 × 1024'],
    ['1600x900', '1600 × 900'],
    ['1440x1080', '1440 × 1080'],
    ['1440x900', '1440 × 900'],
    ['1366x768', '1366 × 768'],
  ];
  const CUSTOM = {
    max_size: [
      ['960', '960'],
      ['1280', '1280'],
      ['1600', '1600'],
      ['0', '原生'],
    ],
    video_bit_rate: [
      ['2000000', '2 Mbps'],
      ['3000000', '3 Mbps'],
      ['4000000', '4 Mbps'],
      ['8000000', '8 Mbps'],
      ['12000000', '12 Mbps'],
      ['16000000', '16 Mbps'],
      ['18000000', '18 Mbps'],
      ['20000000', '20 Mbps'],
    ],
    max_fps: [
      ['15', '15 FPS'],
      ['24', '24 FPS'],
      ['30', '30 FPS'],
      ['45', '45 FPS'],
      ['55', '55 FPS'],
      ['60', '60 FPS'],
    ],
    dpi: [
      ['160', '160 DPI'],
      ['200', '200 DPI'],
      ['240', '240 DPI（默认）'],
      ['280', '280 DPI'],
      ['320', '320 DPI'],
      ['360', '360 DPI'],
      ['400', '400 DPI'],
      ['420', '420 DPI'],
      ['480', '480 DPI'],
      ['560', '560 DPI'],
    ],
  };
  const choice = (options, value) => {
    const select = make('select', 'multi-quality');
    for (const [id, label] of options) {
      const opt = make('option', '', label);
      opt.value = id;
      opt.selected = id === String(value);
      select.append(opt);
    }
    select.value = String(value);
    return select;
  };
  const resolutionChoice = (value) => {
    const select = choice(CUSTOM.max_size, value),
      group = make('optgroup');
    group.label = '实验性分辨率';
    for (const [id, label] of EXPERIMENTAL_RESOLUTIONS) {
      const option = make('option', '', label);
      option.value = 'exp:' + id;
      group.append(option);
    }
    select.append(group);
    select.value = String(value);
    return select;
  };
  const makeQualityChoice = (key, value) =>
    key === 'max_size' ? resolutionChoice(value) : choice(CUSTOM[key], value);
  const defaults = () => ({
    profile: 'custom',
    max_size: 960,
    experimental_resolution: null,
    video_bit_rate: 3000000,
    max_fps: 24,
    dpi: 240,
    low_latency: true,
    screen_off: false,
  });
  const qualityPayload = (v) =>
    v.profile === 'custom'
      ? {
          profile: 'custom',
          quality: {
            max_size: v.experimental_resolution ? 0 : v.max_size,
            video_bit_rate: v.video_bit_rate,
            max_fps: v.max_fps,
          },
        }
      : { profile: v.profile };
  const resolutionExperiment = (v) => {
    if (!v.experimental_resolution) return null;
    const [width, height] = v.experimental_resolution.split('x').map(Number);
    return { mode: 'new_resolution', width, height, dpi: v.dpi };
  };
  const briefQuality = (v) =>
    v.profile === 'custom'
      ? '自定义 · ' +
        (v.experimental_resolution
          ? '实验性虚拟屏幕 ' + v.experimental_resolution.replace('x', '×')
          : v.max_size || '原生') +
        ' / ' +
        v.video_bit_rate / 1000000 +
        ' Mbps / ' +
        v.max_fps +
        ' FPS' +
        (v.experimental_resolution ? ' / ' + v.dpi + ' DPI' : '')
      : (CHOICES.find((x) => x[0] === v.profile) || CHOICES[0])[1];

  const choices = new Map();
  const getChoice = (id) => {
    if (!choices.has(id)) choices.set(id, defaults());
    return choices.get(id);
  };
  const setChoice = (id, part) => {
    choices.set(id, { ...getChoice(id), ...part });
    return choices.get(id);
  };
  function openSettings(view, d) {
    // Native modal with a draft: do not mutate a running/queued session or
    // rebuild the hidden per-device picker until Save is pressed.
    if (view.settingsDialog?.open) return false;
    const previous = view.getChoice(d.id),
      dialog = make('dialog', 'quality-settings-dialog');
    const form = make('form', 'quality-settings-form');
    const head = make('div', 'quality-settings-head'),
      close = make('button', 'secondary', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭投屏参数设置');
    head.append(make('h2', '', '投屏参数 · ' + d.name), close);
    const description = make(
      'p',
      'muted',
      '四项画质参数与播放设置按设备独立保存（本页面会话内）。' +
        '正在投屏时可编辑，但当前会话不热切换，保存后仅对下一次投屏生效。',
    );
    const fields = make('div', 'quality-settings-fields');
    const selectors = {};
    for (const [key, label] of [
      ['max_size', '分辨率上限'],
      ['video_bit_rate', '目标码率'],
      ['max_fps', '最高帧率'],
      ['dpi', 'DPI'],
    ]) {
      const field = make('label', '', label);
      const selected =
        key === 'max_size'
          ? previous.experimental_resolution
            ? 'exp:' + previous.experimental_resolution
            : previous.max_size
          : previous[key];
      const select = makeQualityChoice(key, selected);
      select.setAttribute('aria-label', d.name + ' ' + label);
      selectors[key] = select;
      field.append(select);
      fields.append(field);
    }
    const section = make('fieldset', 'quality-playback');
    section.append(make('legend', '', '播放设置'));
    const latency = make('label', 'quality-setting-check'),
      low = make('input');
    low.type = 'checkbox';
    low.checked = previous.low_latency === true;
    latency.append(low, make('span', '', '低延迟播放实验（仅浏览器追帧，不改变手机编码）'));
    const screenLabel = make('label', 'quality-setting-check'),
      screenOff = make('input');
    screenOff.type = 'checkbox';
    screenOff.checked = previous.screen_off === true && !previous.experimental_resolution;
    screenLabel.append(screenOff, make('span', '', '投屏时关闭手机物理屏幕（远端画面继续显示）'));
    const experimentHint = make(
      'p',
      'muted',
      '实验性虚拟分辨率使用所选 DPI，不改变手机原有系统 DPI；此模式不支持关闭物理屏幕。',
    );
    let hasUnlock = false,
      serverHasUnlock = false;
    const syncExperiment = () => {
      const experimental = selectors.max_size.value.startsWith('exp:');
      screenOff.disabled = experimental || hasUnlock;
      if (screenOff.disabled) screenOff.checked = false;
      experimentHint.hidden = !experimental;
    };
    selectors.max_size.addEventListener('change', syncExperiment);
    syncExperiment();
    section.append(latency, screenLabel, experimentHint);
    const unlockLabel = make('label', 'quality-unlock-entry', '开屏密码（可选）');
    const unlockInput = make('input', 'quality-unlock-input');
    unlockInput.type = 'password';
    unlockInput.maxLength = 32;
    unlockInput.autocomplete = 'new-password';
    unlockInput.placeholder = '4～32 位英文数字；留空表示保留原密码';
    unlockInput.setAttribute('aria-label', d.name + ' 开屏密码');
    const unlockHint = make(
      'p',
      'muted',
      '配置后，单次/批量投屏自动亮屏；仅确认锁屏时滑动、输入密码和回车。',
    );
    const unlockState = make('p', 'muted', '密码状态：正在读取…');
    const clearLabel = make('label', 'quality-setting-check'),
      clear = make('input');
    clear.type = 'checkbox';
    clearLabel.append(clear, make('span', '', '清除已保存的开屏密码'));
    unlockInput.addEventListener('input', () => {
      if (unlockInput.value) clear.checked = false;
      hasUnlock = Boolean(unlockInput.value) || (!clear.checked && serverHasUnlock);
      syncExperiment();
    });
    clear.addEventListener('change', () => {
      if (clear.checked) unlockInput.value = '';
      hasUnlock = Boolean(unlockInput.value) || (!clear.checked && serverHasUnlock);
      syncExperiment();
    });
    unlockLabel.append(unlockInput);
    section.append(unlockLabel, unlockHint, unlockState, clearLabel);
    if (view.readUnlockSettings) {
      Promise.resolve(view.readUnlockSettings(d.id))
        .then((state) => {
          if (dialog.open) {
            serverHasUnlock = state.configured === true;
            hasUnlock = (serverHasUnlock && !clear.checked) || Boolean(unlockInput.value);
            unlockState.textContent =
              '密码状态：' + (state.configured ? '已配置（不会回显）' : '未配置');
            syncExperiment();
          }
        })
        .catch(() => {
          if (dialog.open) unlockState.textContent = '密码状态：读取失败，请检查服务端。';
        });
    } else unlockState.textContent = '密码状态：未配置';
    const footer = make('div', 'modal-actions'),
      cancel = make('button', 'secondary', '取消'),
      save = make('button', '', '保存设置');
    cancel.type = 'button';
    save.type = 'submit';
    footer.append(cancel, save);
    form.append(head, description, fields, section, footer);
    dialog.append(form);
    const dismiss = () => {
      if (dialog.open) dialog.close();
      else dialog.remove();
    };
    close.addEventListener('click', dismiss);
    cancel.addEventListener('click', dismiss);
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (view.settingsDialog === dialog) view.settingsDialog = null;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const resolution = selectors.max_size.value;
      const experiment = resolution.startsWith('exp:') ? resolution.slice(4) : null;
      const password = unlockInput.value,
        remove = clear.checked;
      if (password && !/^[A-Za-z0-9]{4,32}$/.test(password)) {
        unlockState.textContent = '仅支持 4～32 位英文数字密码';
        return;
      }
      const finalize = () => {
        if (!dialog.open) return;
        view.setChoice(d.id, {
          profile: 'custom',
          max_size: experiment ? previous.max_size : Number(resolution),
          experimental_resolution: experiment,
          video_bit_rate: Number(selectors.video_bit_rate.value),
          max_fps: Number(selectors.max_fps.value),
          dpi: Number(selectors.dpi.value),
          low_latency: low.checked,
          screen_off: !experiment && screenOff.checked,
        });
        unlockInput.value = '';
        view.status(d.name + '：投屏参数已保存，下次投屏生效。');
        dismiss();
      };
      if ((password || remove) && view.saveUnlockSettings) {
        save.disabled = true;
        Promise.resolve(view.saveUnlockSettings(d.id, remove ? '' : password))
          .then(finalize)
          .catch(() => {
            save.disabled = false;
            unlockState.textContent = '开屏密码保存失败，请检查服务端并重试。';
          });
      } else finalize();
    });
    documentRef.body.append(dialog);
    view.settingsDialog = dialog;
    dialog.showModal();
    return true;
  }

  return {
    getChoice,
    setChoice,
    qualityPayload,
    resolutionExperiment,
    briefQuality,
    makeQualityChoice,
    openSettings,
  };
}

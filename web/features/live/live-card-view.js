// DOM-only shell. Session, player, transport and launch scheduling stay outside this view.
export function createLiveCardView({ documentRef }) {
  const make = (tag, cls = '', label) => {
    const element = documentRef.createElement(tag);
    if (cls) element.className = cls;
    if (label !== undefined) element.textContent = label;
    return element;
  };
  function createShell({ d, card, experiment, lowLatency, qualityText, probeText, isCurrent }) {
    const box = make('article', 'multi-card'),
      header = make('div', 'heading');
    header.append(
      make(
        'strong',
        '',
        d.name +
          (experiment?.mode === 'new_resolution'
            ? ' · 实验性虚拟屏幕'
            : experiment
              ? ' · 电脑模式实验'
              : ''),
      ),
      make(
        'span',
        'muted',
        d.selected_serial +
          (experiment?.mode === 'display' ? ' · Display ' + experiment.display_id : ''),
      ),
    );
    const screen = make('div', 'multi-screen');
    const video = make('video', 'multi-video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-label', d.name + ' 实时画面');
    screen.append(video);
    // Each live card follows the stream's encoded pixel width, not a grid
    // column or a height-based heuristic. Padding/border total 26 CSS px.
    // max-width:100% only scales a card down when its parent is narrower.
    const fitScreen = (width, height) => {
      if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) return;
      screen.style.aspectRatio = width + ' / ' + height;
      screen.setAttribute('data-orientation', width > height ? 'landscape' : 'portrait');
      screen.style.width = '100%';
      box.style.width = width + 26 + 'px';
    };
    fitScreen(360, 640); // neutral placeholder until stream metadata arrives
    video.addEventListener('loadedmetadata', () => {
      if (isCurrent() && video.videoWidth > 0 && video.videoHeight > 0)
        fitScreen(video.videoWidth, video.videoHeight);
    });
    const state = make('div', 'status', '正在建立本轮会话…');
    const stats = make('div', 'muted', '等待浏览器诊断…');
    const qualityLine = make(
      'div',
      'muted',
      '视频引擎：WebRTC' +
        ' / 本设备画质：' +
        qualityText +
        (lowLatency ? ' / 低延迟播放实验已开启' : '') +
        (card.screenOff ? ' / 已请求投屏时关闭物理屏幕' : '') +
        '（本轮固定）',
    );
    const detail = make('div', 'multi-log');
    const initInfo = make('div', 'muted', probeText || '尚未执行本设备能力预检或视频实验');
    const diagnostic = make('div', 'multi-check-log', '等待本轮视频统计…');
    const eventLog = make('div', 'multi-check-log', '等待本轮会话日志…');
    const history = make('div', 'muted', '本设备暂无历史画质采样（仅在本页内存保留）');
    const xiaomi = make('details', 'multi-help'),
      xiaomiTitle = make('summary', '', '小米 / 澎湃 OS：画面正常但无法控制？'),
      xiaomiHelp = make(
        'div',
        'muted',
        '在手机开发者选项中，除普通 USB 调试和无线调试外，还须检查「USB 调试（安全设置）」是否启用；按手机要求完成授权后重启，再手动连接。单纯显示控制通道已开启，只说明指令写入成功，不代表 Android 已接受点击。先试“主页”，再试屏幕触控。',
      );
    xiaomi.append(xiaomiTitle, xiaomiHelp);
    detail.append(
      make('h4', '', '会话与画质'),
      qualityLine,
      state,
      stats,
      initInfo,
      make('h4', '', 'WebRTC / 资源详情'),
      diagnostic,
      make('h4', '', '本轮事件日志'),
      eventLog,
      make('h4', '', '本页历史'),
      history,
      xiaomi,
    );
    const logPanel = make('section', 'multi-log-panel');
    logPanel.hidden = true;
    logPanel.setAttribute('role', 'dialog');
    logPanel.setAttribute('aria-label', d.name + ' 悬浮日志');
    const logHead = make('div', 'multi-log-head'),
      logClose = make('button', 'secondary multi-log-close', '×');
    logClose.type = 'button';
    logClose.title = '关闭悬浮日志';
    logClose.setAttribute('aria-label', '关闭悬浮日志');
    const stop = make('button', 'danger', '停止此路');
    stop.type = 'button';
    logHead.append(make('strong', '', '本设备诊断日志'), stop, logClose);
    logPanel.append(logHead, detail);
    screen.append(logPanel);
    const fab = make('div', 'multi-fab');
    fab.setAttribute('aria-label', d.name + ' 画面悬浮控制');

    return {
      box,
      header,
      screen,
      video,
      fitScreen,
      state,
      stats,
      qualityLine,
      detail,
      initInfo,
      diagnostic,
      eventLog,
      history,
      logPanel,
      logHead,
      logClose,
      stop,
      fab,
    };
  }
  return { createShell };
}

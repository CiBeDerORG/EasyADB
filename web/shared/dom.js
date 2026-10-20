export function createDomHelpers({ documentRef }) {
  function elem(tag, className, text) {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function action(label, handler, className = 'secondary') {
    const button = elem('button', className, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  return { elem, action };
}

'use strict';

const address = document.getElementById('address');
const form = document.getElementById('connect');
address.addEventListener('input', () => address.setCustomValidity(''));

form.addEventListener('submit', event => {
  event.preventDefault();
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})(?:\/(?:library\/?)?)?$/i.exec(address.value.trim());
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) {
    address.setCustomValidity('请填写带端口的本机 HTTP 地址，例如 http://127.0.0.1:43122。');
    address.reportValidity();
    return;
  }
  const tab = event.submitter?.value === 'latex' ? 'latex' : 'pdf';
  window.location.assign(`http://${match[1].toLowerCase()}:${port}/library/#${tab}`);
});

// The form saves only to this page's DOM. No storage, cookies, network calls, or hidden success state.
const form = document.getElementById('plan-form');
const result = document.getElementById('saved-result');
const prompt = document.getElementById('task-prompt');
prompt.value = prompt.value.replace('this practice page', `this practice page (${location.href})`);
form.addEventListener('submit', event => {
  event.preventDefault();
  const name = document.getElementById('plan-name');
  const when = document.getElementById('plan-when');
  name.setCustomValidity(name.value.trim() ? '' : 'Enter a practice plan name.');
  if (!form.reportValidity()) return;
  document.getElementById('saved-plan').textContent = name.value.trim();
  document.getElementById('saved-when').textContent = when.value;
  result.hidden = false;
  result.focus();
});
document.getElementById('plan-name').addEventListener('input', event => event.target.setCustomValidity(''));

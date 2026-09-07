document.getElementById('stop').addEventListener('click', () => window.computerControl.stop());
window.computerControl.onState(state => { document.getElementById('owner').textContent = `${state.label} is controlling this computer`; });

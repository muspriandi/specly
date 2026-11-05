// Blueprint access page: filter the "assign users" checklist as you type.
(function () {
  var input = document.getElementById('cand-filter');
  var rows = document.querySelectorAll('[data-cand]');
  if (!input) return;
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    rows.forEach(function (r) { r.hidden = q && r.dataset.cand.indexOf(q) === -1; });
  });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
})();

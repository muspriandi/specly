// Mounts Swagger UI for the blueprint named in data-spec. Try-it-out is disabled:
// this app is for reading documentation, not calling the APIs.
window.ui = SwaggerUIBundle({
  url: document.getElementById('swagger').dataset.spec,
  dom_id: '#swagger',
  deepLinking: true,
  supportedSubmitMethods: [],
  docExpansion: 'list',
});

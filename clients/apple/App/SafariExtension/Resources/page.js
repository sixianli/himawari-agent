(() => ({
  url: document.URL,
  title: document.title,
  text: document.body ? document.body.innerText : "",
}))();

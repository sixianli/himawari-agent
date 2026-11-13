globalThis.ExtensionPreprocessingJS = {
  run: (parameters) => {
    parameters.completionFunction({
      url: document.URL,
      title: document.title,
      text: document.body ? document.body.innerText : "",
    });
  },
  finalize: () => {},
};

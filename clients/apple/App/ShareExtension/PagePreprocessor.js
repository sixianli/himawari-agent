var HimawariPage = function () {};

HimawariPage.prototype = {
  run: function (parameters) {
    parameters.completionFunction({
      url: document.URL,
      title: document.title,
      text: document.body ? document.body.innerText : "",
    });
  },
  finalize: function () {},
};

var ExtensionPreprocessingJS = new HimawariPage();

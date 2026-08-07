var ZoteroAI;
var ZoteroAIChromeHandle;

function log(message) {
  Zotero.debug("Zotero AI Assistant: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log("Starting");

  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  ZoteroAIChromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zoteroai", "content/"]
  ]);

  await Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "content/preferences-pane.xhtml",
    scripts: [rootURI + "content/preferences-pane.js"],
    stylesheets: [rootURI + "content/preferences-pane.css"]
  });

  Services.scriptloader.loadSubScript(rootURI + "content/zotero-ai.js");
  ZoteroAI.init({ id, version, rootURI });
  Zotero.ZoteroAI = ZoteroAI;
  ZoteroAI.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  ZoteroAI?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ZoteroAI?.removeFromWindow(window);
}

function shutdown() {
  log("Shutting down");
  ZoteroAI?.removeFromAllWindows();
  ZoteroAI = undefined;
  delete Zotero.ZoteroAI;

  ZoteroAIChromeHandle?.destruct();
  ZoteroAIChromeHandle = undefined;
}

function uninstall() {
  log("Uninstalled");
}

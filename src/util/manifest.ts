import { Manifest } from "../const";
import { corsProxyFetch } from "./cors-proxy";

export const downloadManifest = async (manifestPath: string) => {
  const manifestURL = new URL(manifestPath, location.toString()).toString();
  const resp = await corsProxyFetch(manifestURL);
  if (!resp.ok) {
    throw new Error(`获取清单失败：${resp.status}`);
  }
  const manifest: Manifest = await resp.json();

  if ("new_install_skip_erase" in manifest) {
    console.warn(
      '清单选项 "new_install_skip_erase" 已弃用，请改用 "new_install_prompt_erase"。',
    );
    if (manifest.new_install_skip_erase) {
      manifest.new_install_prompt_erase = true;
    }
  }

  return manifest;
};

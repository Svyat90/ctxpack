// The project root as the IDE sees it, for phpstorm:// links. Under WSL the server sees /home/… or
// /mnt/c/…, while PhpStorm runs on Windows and needs \\wsl.localhost\<distro>\home\… or C:\….
// `ideRoot` in .ctxpack.json overrides the guess (another mount, a network share, a container).
export function ideRootFor(root, cfg = {}, env = process.env, platform = process.platform) {
  if (typeof cfg.ideRoot === 'string' && cfg.ideRoot.trim()) return cfg.ideRoot.trim().replace(/[\\/]+$/, '');
  if (platform !== 'linux' || !env.WSL_DISTRO_NAME || !root.startsWith('/')) return root;
  const drive = /^\/mnt\/([a-z])(?=\/|$)(.*)$/.exec(root);
  if (drive) return `${drive[1].toUpperCase()}:${drive[2].replace(/\//g, '\\') || '\\'}`;
  return `\\\\wsl.localhost\\${env.WSL_DISTRO_NAME}${root.replace(/\//g, '\\')}`;
}

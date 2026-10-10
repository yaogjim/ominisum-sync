import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 每个 clone 目录一个独立的 LaunchAgent（标签含目录哈希，可并存）。 */
export function launchdLabel(repoDir) {
  return `com.omnisum.git-sync.${crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 8)}`;
}

export function plistPath(repoDir, home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${launchdLabel(repoDir)}.plist`);
}

/**
 * @param {{ repoDir: string, nodePath: string, scriptPath: string, intervalSeconds?: number, logDir?: string, remote?: string, branch?: string|null }} options
 */
export function buildPlist({
  repoDir, nodePath, scriptPath, intervalSeconds = 300, logDir = path.join(os.homedir(), 'Library', 'Logs'), remote = 'origin', branch = null,
}) {
  const args = [nodePath, scriptPath, '--repo', path.resolve(repoDir), '--remote', remote, ...(branch ? ['--branch', branch] : []), '--quiet'];
  const label = launchdLabel(repoDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${Math.max(60, Math.floor(intervalSeconds))}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDir, `${label}.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, `${label}.log`))}</string>
</dict>
</plist>
`;
}

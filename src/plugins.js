// 预览插件管理：从 GitHub 插件仓库读取商店、按文件清单增量安装/更新、卸载
//
// 插件仓库结构（见 claude-remote-plugins）：
//   index.json                         商店列表（main 分支）
//   releases/<id>/<version>.json       某个版本的文件清单：每个文件的路径、大小、sha256
//   plugins/<id>/...                   插件文件（按 tag `<id>-v<version>` 取，内容不可变）
// 安装或更新时逐个比对 sha256，只下载变了的文件，没变的直接复用本机已有的。
const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_FILE = '.release.json';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 仓库地址 → 镜像列表。owner/repo 走 GitHub 原站和 jsDelivr（国内可用）；也可以填自己的 http(s) 地址
function mirrorsFor(source) {
  const s = String(source || '').trim().replace(/\/+$/, '');
  if (REPO_RE.test(s)) {
    return [
      (p, ref) => `https://raw.githubusercontent.com/${s}/${ref}/${p}`,
      (p, ref) => `https://cdn.jsdelivr.net/gh/${s}@${ref}/${p}`,
      (p, ref) => `https://fastly.jsdelivr.net/gh/${s}@${ref}/${p}`,
      (p, ref) => `https://gcore.jsdelivr.net/gh/${s}@${ref}/${p}`,
    ];
  }
  if (/^https?:\/\//.test(s)) return [(p, ref) => `${s}/${ref}/${p}`];
  throw new Error('插件仓库地址不对，应为 GitHub 的「用户名/仓库名」');
}

async function fetchBuf(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

class PluginManager {
  constructor(dir) {
    this.dir = dir;
    this.preferred = 0; // 上次成功的镜像，下次优先用
    fs.mkdirSync(dir, { recursive: true });
  }

  // 依次尝试各镜像；给了 sha256 就校验，校验不过换下一个
  async fetchFrom(urls, expect, timeoutMs = 20000) {
    let lastErr;
    for (const url of urls) {
      try {
        const buf = await fetchBuf(url, timeoutMs);
        if (expect && expect.size != null && buf.length !== expect.size) throw new Error('大小不符');
        if (expect && expect.sha256 && sha256(buf) !== expect.sha256) throw new Error('sha256 不符');
        return buf;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`下载失败（已尝试 ${urls.length} 个地址）：${lastErr && lastErr.message}`);
  }

  // 各镜像轮流试，最多三轮（网络抖动、镜像偶尔断开时自动重试）
  async fetchRepo(source, ref, p, expect, timeoutMs) {
    const mirrors = mirrorsFor(source);
    const order = [...mirrors.slice(this.preferred), ...mirrors.slice(0, this.preferred)];
    let lastErr;
    for (let round = 0; round < 3; round++) {
      if (round) await new Promise((r) => setTimeout(r, 600 * round));
      for (let i = 0; i < order.length; i++) {
        try {
          const buf = await this.fetchFrom([order[i](p, ref)], expect, timeoutMs);
          this.preferred = (this.preferred + i) % mirrors.length;
          return buf;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw new Error(`下载 ${p.split('/').pop()} 失败：${lastErr && lastErr.message}`);
  }

  readManifest(id) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'manifest.json'), 'utf8'));
      if (m.id !== id || !Array.isArray(m.extensions)) return null;
      return m;
    } catch (_) {
      return null;
    }
  }

  readRelease(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, id, RELEASE_FILE), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter((id) => ID_RE.test(id))
      .map((id) => this.readManifest(id))
      .filter(Boolean)
      .map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description || '',
        extensions: m.extensions.map((e) => String(e).toLowerCase()),
        entry: m.entry || 'index.html',
        license: m.license || '',
      }));
  }

  async fetchStore(source) {
    const buf = await this.fetchRepo(source, 'main', 'index.json', null, 15000);
    let idx;
    try {
      idx = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      throw new Error('插件商店数据格式不对');
    }
    if (!idx || !Array.isArray(idx.plugins)) throw new Error('插件商店数据格式不对');
    return idx.plugins.filter((p) => p && ID_RE.test(p.id) && p.tag && p.release);
  }

  // onProgress({ done, total, bytes })
  async install(source, item, onProgress) {
    if (!ID_RE.test(item.id)) throw new Error('插件 id 不合法');
    const rel = JSON.parse((await this.fetchRepo(source, item.tag, item.release, null, 15000)).toString('utf8'));
    if (rel.id !== item.id || !Array.isArray(rel.files)) throw new Error('插件文件清单不对');

    const dest = path.join(this.dir, item.id);
    const old = this.readRelease(item.id);
    const oldMap = new Map(((old && old.files) || []).map((f) => [f.path, f.sha256]));
    const tmp = path.join(this.dir, `.tmp-${item.id}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const stats = { downloaded: 0, reused: 0, bytes: 0 };
    try {
      const todo = [];
      for (const f of rel.files) {
        const target = path.resolve(tmp, f.path);
        if (!target.startsWith(tmp + path.sep)) throw new Error('插件清单里有非法路径');
        if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('插件清单缺少 sha256');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 没变的文件：复用本机已有的（再校验一遍，防止本机文件被改过）
        const local = path.join(dest, f.path);
        if (oldMap.get(f.path) === f.sha256 && fs.existsSync(local)) {
          const buf = fs.readFileSync(local);
          if (sha256(buf) === f.sha256) {
            fs.writeFileSync(target, buf);
            stats.reused++;
            continue;
          }
        }
        todo.push({ f, target });
      }
      const total = todo.length;
      let done = 0;
      if (onProgress) onProgress({ done, total, bytes: 0 });
      // 12 个并发下载（pdf.js 的字体映射表有两百多个小文件）
      const queue = [...todo];
      const worker = async () => {
        while (queue.length) {
          const { f, target } = queue.shift();
          const expect = { sha256: f.sha256, size: f.size };
          const ext = Array.isArray(f.urls) ? f.urls.filter((u) => /^https:\/\//.test(u)) : [];
          const buf = ext.length
            ? await this.fetchFrom([...ext, ...ext], expect, 60000)
            : await this.fetchRepo(source, rel.tag || item.tag, `plugins/${item.id}/${f.path}`, expect, 30000);
          fs.writeFileSync(target, buf);
          stats.downloaded++;
          stats.bytes += buf.length;
          done++;
          if (onProgress) onProgress({ done, total, bytes: stats.bytes });
        }
      };
      await Promise.all(Array.from({ length: Math.min(12, todo.length) }, worker));

      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
      if (m.id !== item.id) throw new Error('插件内容与商店信息不一致');
      if (!fs.existsSync(path.join(tmp, m.entry || 'index.html'))) throw new Error('插件缺少入口文件');
      fs.writeFileSync(path.join(tmp, RELEASE_FILE), JSON.stringify({ version: rel.version, tag: rel.tag, files: rel.files.map(({ path: p, sha256: h }) => ({ path: p, sha256: h })) }));
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      return { manifest: this.readManifest(item.id), ...stats };
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  uninstall(id) {
    if (!ID_RE.test(id)) throw new Error('插件 id 不合法');
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }
}

module.exports = { PluginManager, mirrorsFor };

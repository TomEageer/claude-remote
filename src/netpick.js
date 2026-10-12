// 找本机物理网卡的 IPv4 地址：开着 Clash / Flowgate / Shadowrocket 等 TUN 全局代理时，
// 把 SSH 连接绑到这个地址上，流量就从真实网卡直接出去，不被代理接管。
// 注意要问网卡、不要问路由：TUN 持有默认路由，按路由探测拿到的是代理的假地址。
const os = require('os');

const VIRTUAL_NAME = /utun|tun|tap|wintun|clash|meta|mihomo|singbox|sing-box|wireguard|^wg|zerotier|tailscale|vethernet|virtualbox|vmware|vmnet|docker|bridge|llw|awdl|anpi|ap\d|loopback|hyper-v|parallels|vnic/i;
const PREFERRED_NAME = /^(en0|en1|eth0|eth1|wlan0|wi-?fi|wlan|以太网|ethernet|无线网络连接|本地连接)/i;

function inRange(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const toInt = (x) => x.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}
// 代理常用的假地址段、链路本地、CGNAT（Tailscale 等）
const FAKE_RANGES = ['198.18.0.0/15', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8'];

function physicalIPv4() {
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || FAKE_RANGES.some((r) => inRange(a.address, r))) continue;
      cands.push({ name, address: a.address, preferred: PREFERRED_NAME.test(name) });
    }
  }
  cands.sort((x, y) => Number(y.preferred) - Number(x.preferred));
  return cands[0] || null;
}

module.exports = { physicalIPv4 };

module.exports = async function handler(req, res) {
  const r = await fetch('https://api.ipify.org?format=json');
  const d = await r.json();
  res.status(200).json({ egressIp: d.ip });
};

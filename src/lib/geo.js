const crypto = require('crypto');

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Distância em km entre dois pontos {lat, lng} (fórmula de Haversine). */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Move um ponto em linha reta na direção de `to`, no máximo `distKm`.
 * Em escala de cidade, interpolar lat/lng linearmente é preciso o bastante.
 */
function moveToward(from, to, distKm) {
  const total = haversineKm(from, to);
  if (total <= distKm || total === 0) {
    return { lat: to.lat, lng: to.lng, movedKm: total, arrived: true };
  }
  const f = distKm / total;
  return {
    lat: from.lat + (to.lat - from.lat) * f,
    lng: from.lng + (to.lng - from.lng) * f,
    movedKm: distKm,
    arrived: false
  };
}

/**
 * "Geocodificação" simulada: transforma um texto de endereço em coordenadas
 * determinísticas dentro do raio da cidade. O mesmo endereço sempre cai no mesmo lugar.
 * (Em um produto real, aqui entraria uma API de geocodificação.)
 */
function pseudoGeocode(text, center, radiusKm) {
  const hash = crypto.createHash('sha1').update(String(text).trim().toLowerCase()).digest();
  const u1 = hash.readUInt32BE(0) / 0xffffffff;
  const u2 = hash.readUInt32BE(4) / 0xffffffff;
  const angle = u1 * 2 * Math.PI;
  const dist = Math.sqrt(u2) * radiusKm; // sqrt => distribuição uniforme no círculo
  const dLat = (dist * Math.sin(angle)) / 111.32;
  const dLng = (dist * Math.cos(angle)) / (111.32 * Math.cos(toRad(center.lat)));
  return { lat: round(center.lat + dLat, 6), lng: round(center.lng + dLng, 6) };
}

function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

module.exports = { haversineKm, moveToward, pseudoGeocode, round };

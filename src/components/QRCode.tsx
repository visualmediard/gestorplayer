// Código QR encapsulado.
//
// Hoy se renderiza vía api.qrserver.com — el MISMO servicio que ya usa el
// reproductor HTML (player/index.html) — porque `qrcode.react` no pudo
// instalarse (la red del entorno estaba caída: ECONNRESET).
//
// Para migrar a render local (sin terceros) cuando haya red:
//   1) npm install qrcode.react
//   2) import { QRCodeCanvas } from 'qrcode.react'
//   3) reemplazar el <img> de abajo por:
//        <QRCodeCanvas value={value} size={size} level="M" includeMargin />
// El resto del código (Screens.tsx) no cambia: solo consume <QRCode value=… />.

export default function QRCode({ value, size = 200 }: { value: string; size?: number }) {
  const src =
    'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size +
    '&ecc=M&margin=8&data=' + encodeURIComponent(value)
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Código QR de la pantalla"
      style={{ borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', display: 'block' }}
    />
  )
}

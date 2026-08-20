// Vista previa del layout de un programa: dibuja sus zonas a escala dentro del
// lienzo. Es la referencia visual de la tarjeta de Programas — sustituyó a la
// foto subida a mano, que no decía nada de cómo está montado el programa.
//
// Vive aquí, y no dentro de una página, porque la usan tanto Programas como el
// panel de inicio. Duplicarla dejaría dos dibujos del mismo concepto que se
// desincronizarían a la primera.

export type ZoneBox = {
  id: string
  x: number
  y: number
  width: number
  height: number
  background_color: string | null
}

// Paleta fija por posición. No se usa `background_color` de la zona: ese es el
// color detrás del medio (casi siempre negro), así que todas las zonas se
// verían iguales y confundidas con el lienzo. Aquí lo que importa es
// distinguir una zona de otra.
const ZONE_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4']

export default function ZonePreview({ zones, width, height }: {
  zones: ZoneBox[]
  width: number
  height: number
}) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', background: '#0F172A' }}>
      {/* Lienzo del programa, para que se vea el espacio libre sin zonas. */}
      <rect x={0} y={0} width={width} height={height} fill="#1E293B" />
      {zones.map((z, i) => (
        <g key={z.id}>
          <rect x={z.x} y={z.y} width={z.width} height={z.height}
            fill={ZONE_COLORS[i % ZONE_COLORS.length]} fillOpacity={0.85}
            stroke="#F8FAFC" strokeWidth={Math.max(2, width / 300)} />
          {/* Numeración: a este tamaño el nombre no se leería. El tamaño va
              en unidades del viewBox, así escala con la resolución. */}
          <text x={z.x + z.width / 2} y={z.y + z.height / 2}
            fill="#F8FAFC" fontSize={Math.min(z.width, z.height) * 0.45}
            fontWeight="700" textAnchor="middle" dominantBaseline="central">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  )
}

import React from 'react'

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g

/**
 * Лёгкая разметка для rich-текста в словарях и per-lang контенте:
 * **жирный** и `код`. Никакого HTML — только безопасные React-узлы.
 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(TOKEN)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
          return <strong key={i}>{p.slice(2, -2)}</strong>
        }
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
          return <code key={i} className="font-mono text-[0.85em]">{p.slice(1, -1)}</code>
        }
        return <React.Fragment key={i}>{p}</React.Fragment>
      })}
    </>
  )
}

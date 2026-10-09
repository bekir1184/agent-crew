import type { ClientModule } from 'claude-code'

// A transparent layer laid over one agent row. The row itself is drawn by the hooks module
// (sprites and bars need Svg, which a surface module cannot draw); this layer only catches
// the pointer, so a click anywhere on the row opens or closes it. The hover tint is the row
// Box's own `hover` style, so it always matches the row exactly.
//
// A click asks for a state ("open" or "closed"), not a flip. The press sends it; the release
// sends it only when the press never arrived (a redraw can swallow it). Either way one click
// is one request, and repeating a request changes nothing.

type Props = { id: string; open: boolean }
/** Mutable on purpose: listeners read the latest props without a redraw. */
type Ref = { open: boolean; wanted: boolean | null }
type State = { ref: Ref }

const RowHit: ClientModule<Props, State> = (props, surface) => {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    const ref: Ref = { open: props.open, wanted: null }
    surface.setState({ ref })
    surface.onPointer(event => {
      // The left button only: a right or middle click is the surface's own business
      if (event.button !== undefined && event.button !== 'left') return
      if (event.type === 'down') {
        ref.wanted = !ref.open
        // Assume the request lands, so a quick second click reads the new state, not a stale one
        ref.open = ref.wanted
        surface.post({ id: props.id, open: ref.wanted })
      } else if (event.type === 'up') {
        if (ref.wanted === null) {
          // The press was swallowed by a redraw: the release does its job
          ref.open = !ref.open
          surface.post({ id: props.id, open: ref.open })
        }
        ref.wanted = null
      }
    })
  } else {
    surface.state.ref.open = props.open
  }
  return <Box width="100%" height="100%" />
}

export default RowHit

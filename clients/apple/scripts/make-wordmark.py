import io
import sys

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

TEXT = "himawari"
SIZE = 32
TRACKING = 0.2
BOX_HEIGHT = 48


def main(font_path, output_path):
    font = TTFont(font_path)
    font.flavor = None
    units = font["head"].unitsPerEm
    scale = SIZE / units
    buffer_bytes = io.BytesIO()
    font.save(buffer_bytes)
    shaper = hb.Font(hb.Face(buffer_bytes.getvalue()))
    run = hb.Buffer()
    run.add_str(TEXT)
    run.guess_segment_properties()
    hb.shape(shaper, run, {"kern": True, "liga": True})
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    pen = SVGPathPen(glyphs, ntos=lambda value: f"{value:.2f}".rstrip("0").rstrip("."))
    bounds = BoundsPen(glyphs)
    x = 0.0
    for info, position in zip(run.glyph_infos, run.glyph_positions):
        name = order[info.codepoint]
        transform = (scale, 0, 0, -scale, x + position.x_offset * scale, -position.y_offset * scale)
        glyphs[name].draw(TransformPen(pen, transform))
        glyphs[name].draw(TransformPen(bounds, transform))
        x += position.x_advance * scale + TRACKING
    ascent = font["hhea"].ascent * scale
    descent = -font["hhea"].descent * scale
    top = -ascent - (BOX_HEIGHT - ascent - descent) / 2
    left = min(0.0, bounds.bounds[0]) - 0.5
    width = max(x, bounds.bounds[2]) + 0.5 - left
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left:.2f} {top:.2f} {width:.2f} {BOX_HEIGHT}" '
        f'width="{width:.2f}" height="{BOX_HEIGHT}"><path fill="#000000" d="{pen.getCommands()}"/></svg>\n'
    )
    with open(output_path, "w") as handle:
        handle.write(svg)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parent.parent
generated = root / "assets" / "icon" / "generated"
sizes = (16, 24, 32, 48, 64, 128, 256)
images = [Image.open(generated / f"cleanmark-{size}.png").convert("RGBA") for size in sizes]
output = root / "assets" / "icon" / "cleanmark.ico"

images[-1].save(output, format="ICO", sizes=[(size, size) for size in sizes])
print(f"Wrote multi-size ICO to {output}")

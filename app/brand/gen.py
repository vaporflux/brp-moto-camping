import os
BLUE="#1d4159"; BLUE_DEEP="#16344a"; CREAM="#f2efe6"; AMBER="#f0b44a"
H=("M50 46 C48.5 41.5,44 39,38 38.5 C30 37.8,23 38.2,18.5 40.5 C12.5 43.5,11 47.5,14.5 49.3 "
   "C17 50.5,19.2 49.4,18.6 47.2 C18.1 45.2,21 44.4,25 45.4 C31.5 47,37 49.5,41 52 C44.5 54,47.5 55,50 55.2 Z")
def mark(bar,dot):
    return (f'<circle cx="50" cy="31" r="6.8" fill="{dot}"/>'
            f'<g fill="{bar}"><path d="{H}"/><path d="{H}" transform="translate(100,0) scale(-1,1)"/></g>')
BB=(11.0,24.2,89.0,55.2); BW=BB[2]-BB[0]; BH=BB[3]-BB[1]
def sq(size,frac,bg,bar,dot,radius=None):
    s=(size*frac)/BW
    tx=size/2-(BB[0]+BW/2)*s; ty=size/2-(BB[1]+BH/2)*s
    r=f' rx="{radius}"' if radius else ''
    bgel=f'<rect width="{size}" height="{size}"{r} fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}">{bgel}'
            f'<g transform="translate({tx:.3f},{ty:.3f}) scale({s:.5f})">{mark(bar,dot)}</g></svg>')
os.makedirs("out",exist_ok=True)
def w(p,c): open("out/"+p,"w").write(c); print("  ",p)

tight=lambda bar,dot: (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="9 22 82 35" '
                       f'width="820" height="350">{mark(bar,dot)}</svg>')
w("logo-mark.svg", tight(CREAM,AMBER))            # for dark/blue backgrounds
w("logo-mark-on-light.svg", tight(BLUE,AMBER))    # for cream/white backgrounds
w("favicon.svg", sq(64,0.80,BLUE,CREAM,AMBER))    # tile, works on any browser chrome
w("apple-touch-icon.svg", sq(180,0.62,BLUE,CREAM,AMBER))
w("icon-192.svg", sq(192,0.62,BLUE,CREAM,AMBER))
w("icon-512.svg", sq(512,0.62,BLUE,CREAM,AMBER))
w("icon-192-maskable.svg", sq(192,0.46,BLUE,CREAM,AMBER))
w("icon-512-maskable.svg", sq(512,0.46,BLUE,CREAM,AMBER))
w("preview-rounded.svg", sq(512,0.62,BLUE,CREAM,AMBER,radius=114))
for n in (16,32,48): w(f"raster-{n}.svg", sq(n,0.84,BLUE,CREAM,AMBER))
og=(f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">'
    f'<rect width="1200" height="630" fill="{BLUE_DEEP}"/>'
    f'<g transform="translate(600,232) scale(4.55) translate(-50,-40)">{mark(CREAM,AMBER)}</g>'
    f'<text x="600" y="428" text-anchor="middle" fill="{CREAM}" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" '
    f'font-size="60" font-weight="700">Blue Ridge Parkway</text>'
    f'<text x="600" y="486" text-anchor="middle" fill="{AMBER}" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" '
    f'font-size="42" font-weight="600" letter-spacing="6">MOTO CAMPING</text>'
    f'<text x="600" y="546" text-anchor="middle" fill="#9fb6c4" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" '
    f'font-size="26">Campgrounds, fuel and closures &#183; MP 0&#8211;469</text></svg>')
w("og-image.svg", og)

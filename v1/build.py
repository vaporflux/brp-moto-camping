import json
camps=json.load(open('camps.json'))
segs=json.load(open('parkway_segs.json'))

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Blue Ridge Parkway &mdash; Moto Camping Map</title>
<style>__LEAFLET_CSS__</style>
<style>
:root{
  --ink:#12160f; --panel:#1b2118; --panel2:#232b1e; --line:#3a4530;
  --fg:#eef0e8; --dim:#a9b39c; --amber:#e0a33e; --moss:#7fa35c; --rust:#c8552f;
  --sky:#5b93b8;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;background:var(--ink);color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-text-size-adjust:100%}
#app{display:flex;height:100%;width:100%;overflow:hidden}
#map{flex:1;height:100%;background:#0d1109}
#side{width:400px;max-width:44vw;height:100%;display:flex;flex-direction:column;
  background:var(--panel);border-right:1px solid var(--line);z-index:600}
header{padding:14px 16px 10px;border-bottom:1px solid var(--line);background:var(--panel2)}
h1{margin:0;font-size:16px;letter-spacing:.02em}
h1 span{color:var(--amber)}
.sub{margin:4px 0 0;font-size:11.5px;color:var(--dim);line-height:1.5}
.filters{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);
  background:transparent;color:var(--dim);cursor:pointer;white-space:nowrap}
.chip:hover{border-color:var(--moss);color:var(--fg)}
.chip.on{background:var(--moss);border-color:var(--moss);color:#0f1409;font-weight:600}
.chip.on.amber{background:var(--amber);border-color:var(--amber)}
#list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
.row{padding:11px 14px;border-bottom:1px solid #2a3323;cursor:pointer;display:flex;gap:10px;align-items:flex-start}
.row:hover{background:var(--panel2)}
.row.sel{background:#2d3724;box-shadow:inset 3px 0 0 var(--amber)}
.mp{flex:0 0 46px;font-size:10px;color:var(--dim);text-align:right;padding-top:2px;line-height:1.3}
.mp b{display:block;font-size:14px;color:var(--amber);font-weight:700}
.rn{font-size:13.5px;font-weight:600;line-height:1.3}
.rmeta{font-size:11px;color:var(--dim);margin-top:3px;line-height:1.45}
.tag{display:inline-block;font-size:9.5px;padding:1.5px 6px;border-radius:3px;margin:3px 4px 0 0;
  font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.t-moto{background:var(--rust);color:#fff}
.t-top{background:var(--amber);color:#1a1405}
.t-onpkwy{background:var(--sky);color:#07131b}
.t-closed{background:#7a2d2d;color:#ffd9d9}
.sechead{padding:9px 14px 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--moss);background:#161c13;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
footer{padding:9px 14px;border-top:1px solid var(--line);font-size:10.5px;color:var(--dim);line-height:1.5}
#togg{display:none}
/* popup / card */
.leaflet-popup-content-wrapper{background:var(--panel);color:var(--fg);border-radius:8px;
  border:1px solid var(--line);box-shadow:0 8px 30px rgba(0,0,0,.6)}
.leaflet-popup-content{margin:0;width:302px !important}
.leaflet-popup-tip{background:var(--panel);border:1px solid var(--line)}
.leaflet-container a.leaflet-popup-close-button{color:var(--dim)}
.card{padding:14px 15px;font-size:12px;line-height:1.55;max-height:66vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.card h3{margin:0 0 2px;font-size:14.5px;line-height:1.25}
.card .mpline{font-size:11px;color:var(--amber);font-weight:700;margin-bottom:8px}
.card dl{margin:0;display:grid;grid-template-columns:64px 1fr;gap:5px 8px;font-size:11.5px}
.card dt{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding-top:1px}
.card dd{margin:0}
.blurb{margin:9px 0 0;padding-top:9px;border-top:1px solid var(--line);font-size:11.5px}
.warn{margin:7px 0 0;font-size:11.5px;color:#e8b98f}
.warn b,.blurb b{color:var(--amber)}
.btns{display:flex;gap:6px;margin-top:11px;flex-wrap:wrap}
.btn{flex:1;text-align:center;font-size:11px;font-weight:600;padding:7px 8px;border-radius:5px;
  text-decoration:none;background:var(--panel2);color:var(--fg);border:1px solid var(--line);min-width:74px}
.btn:hover{border-color:var(--moss)}
.btn.p{background:var(--moss);color:#0f1409;border-color:var(--moss)}
.pin{border-radius:50%;border:2px solid #0d1109;box-shadow:0 1px 4px rgba(0,0,0,.7);
  display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#12160f}
.legend{position:absolute;right:10px;bottom:22px;z-index:500;background:rgba(27,33,24,.94);
  border:1px solid var(--line);border-radius:7px;padding:9px 11px;font-size:10.5px;color:var(--dim);line-height:1.8}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.legend hr{border:0;border-top:1px solid var(--line);margin:6px 0}
.legend .ln{display:inline-block;width:16px;height:3px;margin-right:6px;vertical-align:2px;border-radius:2px}
@media (max-width:820px){
  #app{flex-direction:column}
  #side{width:100%;max-width:100%;height:52%;border-right:0;border-top:1px solid var(--line);order:2}
  #map{height:48%;order:1;flex:none}
  .legend{display:none}
  #togg{display:block;position:absolute;top:8px;right:8px;z-index:700;background:rgba(27,33,24,.94);
    border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 10px;font-size:11px}
  .leaflet-popup-content{width:238px !important}
}
</style>
</head>
<body>
<div id="app">
  <div id="side">
    <header>
      <h1>Blue Ridge Parkway &mdash; <span>Moto Camping</span></h1>
      <p class="sub">32 campgrounds, MP&nbsp;0&ndash;469. Every one has <b>hot showers and flush toilets</b> &mdash; verified, not assumed. Tap a pin or a row for the full card.</p>
    </header>
    <div class="filters" id="filters"></div>
    <div id="list"></div>
    <footer id="foot"></footer>
  </div>
  <div id="map"><button id="togg">List &#9660;</button></div>
</div>
<div class="legend">
  <i style="background:#c8552f"></i>Motorcycle-only camp<br>
  <i style="background:#e0a33e"></i>Top pick<br>
  <i style="background:#7fa35c"></i>Solid option<br>
  <i style="background:#8d9a80"></i>Backup<br>
  <hr>
  <span class="ln" style="background:#5b93b8"></span>Parkway open<br>
  <span class="ln" style="background:#c8552f"></span>Closed (Aug 16, 2026)
</div>
<script>__LEAFLET_JS__</script>
<script>
"""

TAIL = r"""
var map = L.map('map',{zoomControl:true,scrollWheelZoom:true}).setView([36.75,-81.2], 7);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
  maxZoom:19, subdomains:'abcd',
  attribution:'&copy; OpenStreetMap contributors &copy; CARTO'
}).addTo(map);

SEGS.open.forEach(function(s){ L.polyline(s,{color:'#5b93b8',weight:3.4,opacity:.95}).addTo(map); });
SEGS.closed.forEach(function(s){ L.polyline(s,{color:'#c8552f',weight:4.4,opacity:.95,dashArray:'7,6'}).addTo(map)
  .bindPopup('<div class="card"><h3>Parkway closed</h3><p class="blurb" style="border:0;padding:0;margin:4px 0 0">This stretch is closed to through traffic. Check the NPS closure page the morning you ride &mdash; these move.</p></div>'); });

var CLOSED_MP = SEGS.merged;
function pkwyClosedNear(mp){
  return CLOSED_MP.some(function(r){ return mp >= r[0]-1.0 && mp <= r[1]+1.0; });
}
function color(c){
  if(c.moto) return '#c8552f';
  if(c.tier==='top') return '#e0a33e';
  if(c.tier==='solid') return '#7fa35c';
  return '#8d9a80';
}
function icon(c,big){
  var s = big?26:19, col=color(c);
  return L.divIcon({className:'', iconSize:[s,s], iconAnchor:[s/2,s/2],
    html:'<div class="pin" style="width:'+s+'px;height:'+s+'px;background:'+col+
      (big?';border-color:#fff;border-width:3px':'')+'">'+(c.moto?'M':'')+'</div>'});
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
function card(c){
  var tags='';
  if(c.moto) tags+='<span class="tag t-moto">Moto-only</span>';
  if(c.tier==='top') tags+='<span class="tag t-top">Top pick</span>';
  if(/ON the Parkway|Own access road|Directly ON|Entrance road is directly|100 yards/i.test(c.access)) tags+='<span class="tag t-onpkwy">On the Parkway</span>';
  if(pkwyClosedNear(c.mp)) tags+='<span class="tag t-closed">Parkway closure nearby</span>';
  var gmaps='https://www.google.com/maps/search/?api=1&query='+c.lat+','+c.lon;
  return '<div class="card"><h3>'+esc(c.name)+'</h3>'+
    '<div class="mpline">Milepost '+c.mp+' &middot; '+c.state+'</div>'+ (tags?tags+'<div style="height:8px"></div>':'')+
    '<dl>'+
    '<dt>Getting&nbsp;in</dt><dd>'+esc(c.access)+'</dd>'+
    '<dt>Showers</dt><dd>'+esc(c.showers)+'</dd>'+
    '<dt>Toilets</dt><dd>'+esc(c.restrooms)+'</dd>'+
    '<dt>Pad</dt><dd>'+esc(c.pad)+'</dd>'+
    '<dt>Price</dt><dd>'+esc(c.price)+'</dd>'+
    '<dt>Season</dt><dd>'+esc(c.season)+'</dd>'+
    '<dt>Group</dt><dd>'+esc(c.group)+'</dd>'+
    '<dt>Rating</dt><dd>'+esc(c.rating)+'</dd>'+
    '<dt>Food</dt><dd>'+esc(c.food)+'</dd>'+
    '</dl>'+
    '<p class="blurb"><b>Why it works:</b> '+esc(c.standout)+'</p>'+
    '<p class="warn"><b>Watch out:</b> '+esc(c.watchout)+'</p>'+
    '<div class="btns"><a class="btn p" href="'+gmaps+'" target="_blank" rel="noopener">Navigate</a>'+
    '<a class="btn" href="tel:'+c.phone.replace(/[^0-9+]/g,'')+'">'+esc(c.phone.split('/')[0].trim())+'</a>'+
    '<a class="btn" href="'+c.url+'" target="_blank" rel="noopener">Website</a></div>'+
    '<div style="margin-top:7px;font-size:10px;color:#8f9a83">'+c.lat.toFixed(5)+', '+c.lon.toFixed(5)+'</div>'+
    '</div>';
}

var markers={}, selected=null;
CAMPS.forEach(function(c){
  var m=L.marker([c.lat,c.lon],{icon:icon(c,false)}).addTo(map);
  m.bindPopup(card(c),{maxWidth:320,autoPanPadding:[24,24]});
  m.on('click',function(){ select(c.id,false); });
  markers[c.id]=m;
});

var FILTERS=[
  {k:'all',   t:'All 32',            f:function(){return true}},
  {k:'moto',  t:'Moto-only camps',   f:function(c){return c.moto}, amber:true},
  {k:'top',   t:'Top picks',         f:function(c){return c.tier==='top'}, amber:true},
  {k:'on',    t:'On / &lt;1 mi off Parkway', f:function(c){return /ON the Parkway|Own access road|Directly ON|Entrance road is directly|100 yards|1\/4 mile|0\.3 mi/i.test(c.access)}},
  {k:'group', t:'Real group sites',  f:function(c){return /^YES/.test(c.group)}},
  {k:'firm',  t:'Firm pads',         f:function(c){return c.pad==='paved'||c.pad==='gravel'}},
  {k:'yr',    t:'Year-round',        f:function(c){return /Year-round/i.test(c.season)}},
  {k:'cheap', t:'Under $30',         f:function(c){return /\$(1[0-9]|2[0-9])\b/.test(c.price)}},
  {k:'va',    t:'Virginia',          f:function(c){return c.state==='VA'}},
  {k:'nc',    t:'N. Carolina',       f:function(c){return c.state==='NC'}}
];
var active='all';
var fw=document.getElementById('filters');
FILTERS.forEach(function(f){
  var b=document.createElement('button');
  b.className='chip'+(f.amber?' amber':'')+(f.k===active?' on':'');
  b.innerHTML=f.t; b.dataset.k=f.k;
  b.onclick=function(){ active=f.k; render(); };
  fw.appendChild(b);
});

function render(){
  [].forEach.call(fw.children,function(b){ b.classList.toggle('on', b.dataset.k===active); });
  var f=FILTERS.filter(function(x){return x.k===active})[0].f;
  var shown=CAMPS.filter(f);
  var L_=document.getElementById('list'); L_.innerHTML='';
  var lastSec=null;
  shown.forEach(function(c){
    var sec = c.mp<120?'Virginia — north (MP 0–120)': c.mp<217?'Virginia — south (MP 120–217)':
              c.mp<340?'N. Carolina — north (MP 217–340)':'N. Carolina — south (MP 340–469)';
    if(sec!==lastSec){ var h=document.createElement('div'); h.className='sechead'; h.textContent=sec; L_.appendChild(h); lastSec=sec; }
    var r=document.createElement('div'); r.className='row'; r.dataset.id=c.id;
    var tags='';
    if(c.moto) tags+='<span class="tag t-moto">Moto-only</span>';
    if(c.tier==='top') tags+='<span class="tag t-top">Top pick</span>';
    if(pkwyClosedNear(c.mp)) tags+='<span class="tag t-closed">Closure nearby</span>';
    r.innerHTML='<div class="mp"><b>'+c.mp+'</b>MP</div><div style="flex:1"><div class="rn">'+esc(c.name)+'</div>'+
      '<div class="rmeta">'+esc(c.price)+' &middot; '+esc(c.pad)+' pads &middot; '+esc(c.rating.split(' (')[0])+'</div>'+tags+'</div>';
    r.onclick=function(){ select(c.id,true); };
    L_.appendChild(r);
  });
  Object.keys(markers).forEach(function(id){
    var on = shown.some(function(c){return String(c.id)===String(id)});
    if(on){ if(!map.hasLayer(markers[id])) markers[id].addTo(map); }
    else { if(map.hasLayer(markers[id])) map.removeLayer(markers[id]); }
  });
  document.getElementById('foot').innerHTML = shown.length+' of 32 shown. Parkway closures shown in red are current as of <b>Aug 16, 2026</b> (NPS) &mdash; re-check nps.gov/blri before you leave. Prices and seasons are 2026 published rates; call to confirm a group booking.';
}
function select(id,fly){
  CAMPS.forEach(function(c){ markers[c.id].setIcon(icon(c, c.id===id)); });
  var c=CAMPS.filter(function(x){return x.id===id})[0];
  [].forEach.call(document.querySelectorAll('.row'),function(r){ r.classList.toggle('sel', r.dataset.id==String(id)); });
  if(fly){ map.setView([c.lat,c.lon], Math.max(map.getZoom(),10), {animate:true}); }
  markers[id].openPopup();
  selected=id;
}
render();
map.fitBounds(L.latLngBounds(CAMPS.map(function(c){return [c.lat,c.lon]})), {padding:[40,40]});

document.getElementById('togg').onclick=function(){
  var s=document.getElementById('side');
  var hidden = s.style.display==='none';
  s.style.display = hidden?'flex':'none';
  document.getElementById('map').style.height = hidden?'48%':'100%';
  this.innerHTML = hidden?'List &#9660;':'List &#9650;';
  setTimeout(function(){map.invalidateSize()},60);
};
</script>
</body>
</html>
"""

with open('brp-moto-camping-map.html','w') as f:
    f.write(HEAD.replace("__LEAFLET_CSS__", open("leaflet.css").read()).replace("__LEAFLET_JS__", open("leaflet.js").read()))
    f.write("var CAMPS=" + json.dumps(camps) + ";\n")
    f.write("var SEGS=" + json.dumps(segs) + ";\n")
    f.write(TAIL)
print("ok")

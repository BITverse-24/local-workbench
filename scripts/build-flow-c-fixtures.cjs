const { createCanvas } = require('canvas');
const fs = require('node:fs');
const path = require('node:path');

function plate(text,width=220,height=55) {
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.fillStyle='#222';ctx.font='bold 25px Arial';ctx.fillText(text,12,36);
  return canvas.toBuffer('image/png').toString('base64');
}
function drawing(scenario,{rating=150,lineSize=80,branchSize=40,obscured=false}={}) {
  if(scenario===1)return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="584" viewBox="0 0 1200 700">
<rect width="1200" height="700" fill="white"/>
<g font-family="Arial" fill="#222">
<text x="60" y="60" font-size="28" font-weight="bold">P-204 PUMP SKID - DESIGN REVIEW DRAWING</text>
<text x="60" y="92" font-size="16">Drawing: PID-P204-REV-C | Hydrocarbon service | Not to scale</text>
<line x1="120" y1="350" x2="1040" y2="350" stroke="#222" stroke-width="20"/>
<text x="130" y="245" font-size="18">DN100 suction</text>
<text x="850" y="320" font-size="18">DN${lineSize} discharge</text>
<circle cx="280" cy="350" r="80" fill="white" stroke="#222" stroke-width="8"/>
<text x="243" y="358" font-size="24">P-204</text>
<polygon points="550,300 620,350 550,400" fill="white" stroke="#222" stroke-width="8"/>
<polygon points="690,300 620,350 690,400" fill="white" stroke="#222" stroke-width="8"/>
<text x="558" y="270" font-size="18">XV-204</text>
<path d="M620 405 L620 455" stroke="#222" stroke-width="3"/>
<rect x="510" y="455" width="240" height="95" fill="white" stroke="#222" stroke-width="2"/>
<image x="520" y="460" width="220" height="55" xlink:href="data:image/png;base64,${plate(obscured?'UNREADABLE':`CLASS ${rating}`)}"/>
<text x="530" y="535" font-size="16">valve rating</text>
<text x="60" y="640" font-size="18">Service: hydrocarbon | Drawing supplied for design review</text>
</g></svg>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="500" viewBox="0 0 1000 500">
<rect width="1000" height="500" fill="white"/>
<g font-family="Arial" fill="#222">
<text x="35" y="42" font-size="23" font-weight="bold">UTILITY MANIFOLD U-18 - CONSTRUCTION DRAWING</text>
<line x1="115" y1="220" x2="885" y2="220" stroke="#222" stroke-width="16"/>
<text x="365" y="198" font-size="19">HEADER DN150</text>
<line x1="260" y1="220" x2="260" y2="300" stroke="#222" stroke-width="12"/>
<circle cx="260" cy="320" r="26" fill="none" stroke="#222" stroke-width="5"/>
<text x="95" y="365" font-size="18">BRANCH U18-A: DN${branchSize}</text>
<image x="115" y="380" width="220" height="55" xlink:href="data:image/png;base64,${plate(obscured?'UNREADABLE':`CLASS ${rating}`)}"/>
<text x="120" y="452" font-size="15">branch flange rating</text>
<line x1="680" y1="220" x2="680" y2="300" stroke="#222" stroke-width="12"/>
<circle cx="680" cy="320" r="26" fill="none" stroke="#222" stroke-width="5"/>
<text x="475" y="365" font-size="18">BRANCH U18-B: DN50 / FLANGE CLASS 300</text>
<text x="35" y="485" font-size="15">Drawing ID: U18-M-04 Rev B | Service: hot water | Status: IFC review</text>
</g></svg>\n`;
}
module.exports={drawing};
if(require.main===module){
  const root=path.resolve(__dirname,'../demo/flow_c');
  fs.writeFileSync(path.join(root,'scenario-1/pump-skid-P204.svg'),drawing(1));
  fs.writeFileSync(path.join(root,'scenario-3/workspace/utility-manifold-U18.svg'),drawing(3));
}

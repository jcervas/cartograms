(function(){
  "use strict";
  const root=document.getElementById("pl");

  function boot(DATA){
  const NS="http://www.w3.org/2000/svg";
  const svg=document.getElementById("pl-map");
  const W=DATA.w, H=DATA.h;
  svg.setAttribute("viewBox","0 0 "+W+" "+H);

  document.getElementById("pl-m-frame").textContent=Math.round(W)+" x "+Math.round(H)+" px";
  const ks=DATA.s.map(s=>s.k);
  const kmax=DATA.s[ks.indexOf(Math.max(...ks))], kmin=DATA.s[ks.indexOf(Math.min(...ks))];
  const seatWord=n=>n+(n===1?" seat":" seats");
  document.getElementById("pl-m-max").textContent=kmax.k.toFixed(2)+"x  "+kmax.st+" ("+seatWord(kmax.seats)+")";
  document.getElementById("pl-m-min").textContent=kmin.k.toFixed(2)+"x  "+kmin.st+" ("+seatWord(kmin.seats)+")";

  const gSlots=document.createElementNS(NS,"g");
  const gStates=document.createElementNS(NS,"g");
  const gDetail=document.createElementNS(NS,"g");
  svg.appendChild(gSlots); svg.appendChild(gStates); svg.appendChild(gDetail);

  // hand-drawn slots, revealed at step 3
  DATA.s.forEach(s=>{
    if(s.rw<=0) return;
    const r=document.createElementNS(NS,"rect");
    r.setAttribute("x",s.lx); r.setAttribute("y",s.ly);
    r.setAttribute("width",s.rw); r.setAttribute("height",s.rh);
    r.setAttribute("fill","var(--pl-accent-soft)"); r.setAttribute("stroke","var(--pl-accent)");
    r.setAttribute("stroke-width",.8); r.setAttribute("opacity",0);
    gSlots.appendChild(r); s._slot=r;
  });

  DATA.s.forEach(s=>{
    const g=document.createElementNS(NS,"g");
    const p=document.createElementNS(NS,"path");
    p.setAttribute("d",s.d);
    p.setAttribute("fill","var(--pl-wash)");
    p.setAttribute("stroke","var(--pl-ink-2)");
    p.setAttribute("stroke-width",.6);
    p.setAttribute("stroke-linejoin","round");
    g.appendChild(p); gStates.appendChild(g);
    s._g=g; s._p=p;
  });

  // Maryland / Virginia discs, drawn only in the detail step
  function discGroup(pts,colour){
    const g=document.createElementNS(NS,"g");
    g.setAttribute("opacity",0);
    pts.forEach(pt=>{
      const c=document.createElementNS(NS,"circle");
      c.setAttribute("cx",pt[0]); c.setAttribute("cy",pt[1]); c.setAttribute("r",1);
      c.setAttribute("fill","none"); c.setAttribute("stroke",colour);
      c.setAttribute("stroke-width",.35);
      g.appendChild(c);
    });
    gDetail.appendChild(g); return g;
  }
  const discMD=discGroup(DATA.md,"var(--pl-accent)"), discVA=discGroup(DATA.va,"var(--pl-warn)");

  // Each stage is an affine per state, so moving between stages is interpolation.
  //   geographic : identity
  //   sized      : scale k about the state's own centre, so it stays put
  //   placed     : scale k about its bbox corner, then translate to the slot
  function affine(s,stage){
    if(stage===0) return [1,0,0];
    if(stage===1||stage===2) return [s.k, s.cx-s.k*s.cx, s.cy-s.k*s.cy];
    return [s.k, s.tx, s.ty];
  }

  const STEPS=[
    {t:"Start from the real map",
     b:"Every state in its true position &mdash; a US Albers projection with Alaska and Hawaii inset, fitted to the frame. Area here is land area, which is exactly the thing that misleads: Wyoming covers twelve times the ground of New Jersey and holds one seat against its twelve.",
     f:null, val:s=>"scale 1.00 everywhere"},
    {t:"Resize each state to its seat count",
     b:"Scale every state so its <em>area</em> becomes proportional to its share of the 435 seats. New Jersey grows, Wyoming shrinks. Done in place, so you can see the problem this creates: the country now collides with itself, badly in the Northeast.",
     f:"k = &radic;( totalArea &times; seatShare / area / 2.9 )", val:s=>"scale "+s.k.toFixed(2)+"x"},
    {t:"Bring in the slots", slots:true,
     b:"Karim Douieb drew one rectangle per state by hand in Figma, arranged so the country stays recognisable. Nothing computes these &mdash; they are a designed object, and the pipeline lifts them straight out of his notebook. They are the target each state is aiming for.",
     f:null, val:s=>"slot "+Math.round(s.rw)+" &times; "+Math.round(s.rh)+" px"},
    {t:"Move each state to its slot", slots:true,
     b:"Scale about the state's own bounding-box corner, then move that corner onto the slot's corner. Those two operations collapse into a single affine, which is exactly what the output JSON stores per state &mdash; no renderer has to re-derive it.",
     f:"x&prime; = x &middot; k + tx &nbsp;&nbsp; y&prime; = y &middot; k + ty",
     val:s=>"tx "+s.tx.toFixed(0)+", ty "+s.ty.toFixed(0)},
    {t:"Push apart until nothing touches", zoom:true,
     b:"Slots were drawn for one set of sizes, so a different apportionment can still leave states touching. Each outline carries a chain of discs of radius <em>padding/2</em>; two discs meeting means the boundaries are exactly <em>padding</em> apart. Maryland and Virginia were 0.34px apart &mdash; visually touching. They are now 1.82px.",
     f:"disc radius = padding / 2 &nbsp;&nbsp; &rarr; &nbsp;&nbsp; gap &ge; padding",
     val:s=>"padding 2.0 px &middot; minimum gap 1.82 px"}
  ];

  let stage=0, hover=null, anim=null, settle=null;
  const ol=document.getElementById("pl-steps");
  STEPS.forEach((s,i)=>{
    const li=document.createElement("li");
    li.tabIndex=0;
    li.innerHTML='<span class="pl-num">STEP '+(i+1)+'</span><h3>'+s.t+'</h3><p>'+s.b+'</p>'+
      (s.f?'<div class="pl-formula">'+s.f+'</div>':'');
    li.addEventListener("click",()=>go(i));
    li.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go(i);}});
    ol.appendChild(li); s._li=li;
  });

  function paint(t){
    // t is a continuous position between stage a and b. Everything that varies
    // per stage is interpolated from the stage's own flag rather than from a
    // threshold on t -- thresholds put the zoom a step out of sync with the
    // shapes, because the last frame of a transition does not always land where
    // a hand-tuned cutoff expects.
    const a=Math.floor(t), b=Math.min(STEPS.length-1,a+1), u=t-a;
    const lerpFlag=(key)=>{
      const A=STEPS[a][key]?1:0, B=STEPS[b][key]?1:0;
      return A+(B-A)*u;
    };
    const slotAmt=lerpFlag("slots"), det=lerpFlag("zoom");
    DATA.s.forEach(s=>{
      const A=affine(s,a), B=affine(s,b);
      const k=A[0]+(B[0]-A[0])*u, tx=A[1]+(B[1]-A[1])*u, ty=A[2]+(B[2]-A[2])*u;
      s._g.setAttribute("transform","translate("+tx+","+ty+") scale("+k+")");
      s._p.setAttribute("stroke-width",0.6/k);
      if(s._slot) s._slot.setAttribute("opacity", slotAmt);
    });
    discMD.setAttribute("opacity",det); discVA.setAttribute("opacity",det);
    DATA.s.forEach(s=>{
      const focus = det>0.4 && (s.st==="MD"||s.st==="VA");
      s._p.setAttribute("fill", focus ? (s.st==="MD"?"var(--pl-accent-soft)":"var(--pl-warn-soft)") : "var(--pl-wash)");
    });
    // zoom to the Maryland / Virginia detail on the last step
    const md=DATA.s.find(x=>x.st==="MD"), va=DATA.s.find(x=>x.st==="VA");
    const bx0=Math.min(md.lx,va.lx)-26, by0=Math.min(md.ly,va.ly)-26;
    const bx1=Math.max(md.lx+md.k*(md.bb[2]-md.bb[0]),va.lx+va.k*(va.bb[2]-va.bb[0]))+26;
    const by1=Math.max(md.ly+md.k*(md.bb[3]-md.bb[1]),va.ly+va.k*(va.bb[3]-va.bb[1]))+26;
    let vw=bx1-bx0, vh=vw*H/W, vx=bx0, vy=(by0+by1)/2-vh/2;
    if(vh<by1-by0){vh=by1-by0; vw=vh*W/H; vx=(bx0+bx1)/2-vw/2; vy=by0;}
    const e=det;
    svg.setAttribute("viewBox",[0+(vx-0)*e, 0+(vy-0)*e, W+(vw-W)*e, H+(vh-H)*e].join(" "));
  }

  function go(i){
    i=Math.max(0,Math.min(STEPS.length-1,i));
    const from=stage; stage=i;
    STEPS.forEach((s,j)=>s._li.setAttribute("aria-current",j===i?"true":"false"));
    document.getElementById("pl-stage-label").innerHTML=STEPS[i].t;
    const ref=hover||DATA.s.find(s=>s.st==="NJ");
    document.getElementById("pl-stage-val").innerHTML=STEPS[i].val(ref);
    document.getElementById("pl-prev").disabled=i===0;
    document.getElementById("pl-next").disabled=i===STEPS.length-1;
    if(anim) cancelAnimationFrame(anim);
    if(settle) clearTimeout(settle);
    const reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(reduce||from===i){paint(i);return;}
    const t0=performance.now(), dur=760;
    let done=false;
    (function step(now){
      const u=Math.min(1,(now-t0)/dur);
      const e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
      paint(from+(i-from)*e);
      if(u<1){ anim=requestAnimationFrame(step); } else { anim=null; done=true; }
    })(t0);
    // The animation's first frame paints where we came FROM. If rAF never runs --
    // a background tab, a throttled preview -- that would leave the page showing
    // the previous step for good. Guarantee the destination either way.
    settle=setTimeout(()=>{ if(!done) paint(i); }, dur+90);
  }

  gStates.addEventListener("mousemove",e=>{
    const s=DATA.s.find(x=>x._p===e.target);
    if(!s) return;
    hover=s;
    document.getElementById("pl-stage-val").innerHTML=
      "<strong>"+s.n+"</strong> &middot; "+seatWord(s.seats)+" &middot; "+STEPS[stage].val(s);
  });
  gStates.addEventListener("mouseleave",()=>{hover=null;go(stage);});

  document.getElementById("pl-prev").addEventListener("click",()=>go(stage-1));
  document.getElementById("pl-next").addEventListener("click",()=>go(stage+1));
  document.addEventListener("keydown",e=>{
    if(e.key==="ArrowRight"){go(stage+1);} else if(e.key==="ArrowLeft"){go(stage-1);}
  });

  go(0);
}

  // Standalone build injects the payload; the hosted page fetches it.
  if (window.PLACEMENT_DATA) { boot(window.PLACEMENT_DATA); }
  else {
    const src=root.getAttribute("data-src");
    fetch(src).then(r=>{ if(!r.ok) throw new Error(r.status+" "+r.statusText); return r.json(); })
      .then(boot)
      .catch(e=>{
        const d=document.createElement("div");
        d.className="pl-err";
        d.textContent="Could not load "+src+" ("+e.message+"). This page needs to be "+
          "served over http:// -- browsers block file:// requests.";
        root.appendChild(d);
      });
  }
})();

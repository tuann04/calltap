"""Patch Neko's static frontend for responsive mobile viewport, audio/mic controls, and reliable iOS touch."""

import hashlib
from pathlib import Path

WWW_DIR = Path("/var/www")


def patch_index_html(js_renames: dict[str, str]) -> None:
    index_path = WWW_DIR / "index.html"
    html = index_path.read_text("utf-8")

    old_vp = 'content="width=device-width,initial-scale=1.0"'
    new_vp = 'content="width=device-width,initial-scale=1.0,maximum-scale=1.0,viewport-fit=cover"'
    if old_vp in html:
        html = html.replace(old_vp, new_vp, 1)
    elif new_vp not in html:
        raise RuntimeError("viewport meta tag not found in index.html")

    for old_name, new_name in js_renames.items():
        assert old_name in html, f"Expected {old_name} reference in index.html"
        html = html.replace(old_name, new_name)

    css_path = WWW_DIR / "mobile-fix.css"
    if css_path.exists():
        css_hash = hashlib.sha256(css_path.read_bytes()).hexdigest()[:8]
        hashed_css = f"mobile-fix.{css_hash}.css"
        css_path.rename(WWW_DIR / hashed_css)
    else:
        hashed_css = "mobile-fix.css"

    css_tag = f'    <link rel="stylesheet" href="./{hashed_css}">'
    if "mobile-fix" not in html:
        assert "</head>" in html, "</head> not found in index.html"
        html = html.replace("</head>", f"{css_tag}\n  </head>", 1)

    index_path.write_text(html, "utf-8")


def patch_app_js() -> dict[str, str]:
    candidates = sorted((WWW_DIR / "assets").glob("index-*.js"))
    if not candidates:
        raise RuntimeError("No /var/www/assets/index-*.js bundle found")

    old_touch_block = (
        'onTouch(e){if(!this.client.controlling){e.type==="touchstart"&&this.client.implicitControl&&'
        'this.client.request();return}if(e.preventDefault(),e.stopPropagation(),'
        'this.client.state.control.locked)return;if(this.client.state.control.touch){'
        'for(const o of e.changedTouches){const i=this.pos(o);this.client.input.touch('
        'it[e.type],o.identifier,i.x,i.y,Math.round(o.force*255))}return}const t=e.changedTouches[0];'
        'this.move(this.pos(t)),e.type==="touchstart"?this.button(1,!0):e.type!=="touchmove"&&'
        'this.button(1,!1)}onControl(e){this.ctrlDown=0,this.noKeyUp.clear(),this.updateCursorStyle(),'
        'this.draw();const t=this.pendingPress;if(this.pendingPress=null,e&&t&&performance.now()-t.at<2e3){'
        'const o=t.e;this.move(this.pos(o)),this.button(o.button+1,!0),this.mouseDown||this.button(o.button+1,!1)}}'
    )

    new_touch_block = (
        'onTouch(e){e.preventDefault(),e.stopPropagation();if(!this.client.controlling){'
        'if(this.client.implicitControl){const t=e.changedTouches[0];'
        'if(e.type==="touchstart"&&t){this.pendingTouch={id:t.identifier,p:this.pos(t),down:!0,at:performance.now()},'
        'this.client.request()}else if(this.pendingTouch&&t&&t.identifier===this.pendingTouch.id){'
        'this.pendingTouch.p=this.pos(t),e.type!=="touchmove"&&(this.pendingTouch.down=!1)}}return}'
        'if(this.client.state.control.locked)return;if(this.client.state.control.touch){'
        'const m=this._tm||(this._tm=new Map),end=e.type==="touchend"||e.type==="touchcancel";'
        'for(const o of e.changedTouches){let sid;if(e.type==="touchstart"){if(!m.has(o.identifier)){'
        'let s=0;const used=new Set(m.values());while(used.has(s))s++;m.set(o.identifier,s)}sid=m.get(o.identifier)}'
        'else{if(!m.has(o.identifier))continue;sid=m.get(o.identifier),end&&m.delete(o.identifier)}'
        'const i=this.pos(o);this.client.input.touch(it[e.type],sid,i.x,i.y,Math.round((o.force||0)*255))}return}'
        'const t=e.changedTouches[0];t&&(this.move(this.pos(t)),e.type==="touchstart"?this.button(1,!0):'
        'e.type!=="touchmove"&&this.button(1,!1))}'
        'onControl(e){this.ctrlDown=0,this.noKeyUp.clear(),this.updateCursorStyle(),this.draw();'
        'const t=this.pendingPress;if(this.pendingPress=null,e&&t&&performance.now()-t.at<2e3){'
        'const o=t.e;this.move(this.pos(o)),this.button(o.button+1,!0),this.mouseDown||this.button(o.button+1,!1)}'
        'const pt=this.pendingTouch;if(this.pendingTouch=null,!e){this._tm&&this._tm.clear();return}'
        'if(pt&&performance.now()-pt.at<2e3){if(this.client.state.control.touch){'
        'const m=this._tm||(this._tm=new Map);let sid=0;const used=new Set(m.values());while(used.has(sid))sid++;'
        'this.client.input.touch("begin",sid,pt.p.x,pt.p.y,0),'
        'pt.down?m.set(pt.id,sid):this.client.input.touch("end",sid,pt.p.x,pt.p.y,0)}'
        'else this.move(pt.p),this.button(1,!0),pt.down||this.button(1,!1)}}'
    )

    old_set_muted = 'setMuted(e){this.video&&(this.video.muted=e),e||(this.state.video.mutedByAutoplay=!1,this.emitState())}'
    new_set_muted = (
        'setMuted(e){if(this.video){this.video.muted=e,'
        'e||(this.state.video.mutedByAutoplay=!1,this.video.paused&&this.video.play().catch(()=>{}));'
        'this.state.video.muted=this.video.muted,this.emitState()}}'
    )

    old_ci = (
        'function ci(){const{t:s}=V(),{client:e,app:t}=O(),o=ne(),i=k(e.store,Y),a=k(e.store,c=>c.settings),'
        'l=k(t,c=>c.side),r=Ae("header.item"),d=Ae("side.tab"),p=(c,h)=>{const f=ye(c,a),'
        'b=s(i?`locks.${c}.${f?"unlock":"lock"}`:`locks.${c}.${f?"locked":"unlocked"}`);return n.jsx("li",{'
        'className:"mr-2.5 inline-block",children:n.jsx(A,{variant:"header",label:b,className:F(f&&"text-style-error/50"),'
        '"data-testid":`lock-${c}`,"data-locked":f||void 0,"aria-disabled":!i,onClick:()=>i&&o.toggleLock(c),children:h})})};'
        'return n.jsxs("div",{className:"flex flex-1 flex-row items-center",children:[n.jsxs("a",{'
        'href:"https://github.com/m1k1o/neko",title:"Github repository",target:"_blank",rel:"noreferrer",'
        'className:"ml-5 flex w-[150px] flex-1 items-center justify-start",children:[n.jsx("img",{src:ke,alt:"n.eko",'
        'className:"mr-2.5 block h-7.5"}),n.jsxs("span",{className:"text-[30px] leading-7.5",children:['
        'n.jsx("b",{className:"font-black",children:"n"}),".eko"]})]}),n.jsxs("ul",{className:"mr-2.5 whitespace-nowrap",'
        'children:[p("control",n.jsx(Tt,{className:"size-4"})),p("login",ye("login",a)?n.jsx(St,{className:"size-4"}):'
        'n.jsx(Ct,{className:"size-4"})),r.map(({id:c,component:h})=>n.jsx(h,{},c)),n.jsx(Ze,{items:d,'
        'use:c=>c.useBadge??li,children:c=>n.jsx(di,{side:l,unread:c.reduce((h,f)=>h+f,0)})})]})]})}'
    )

    new_ci = (
        'function ci(){const{t:s}=V(),{client:e,app:t}=O(),o=ne(),i=k(e.store,Y),a=k(e.store,c=>c.settings),'
        '{muted:z,connected:cn,canShareMedia:cm}=k(e.store,Z(c=>({muted:c.video.muted,'
        'connected:c.connection.status==="connected",canShareMedia:!!Pe(c)?.profile.can_share_media}))),'
        '[mo,ms2]=v.useState(()=>!!window.__nekoMicOn),'
        'l=k(t,c=>c.side),r=Ae("header.item"),d=Ae("side.tab");'
        'v.useEffect(()=>{const h=()=>ms2(!!window.__nekoMicOn);return window.addEventListener("neko-mic",h),'
        '()=>window.removeEventListener("neko-mic",h)},[]);'
        'const p=(c,h)=>{const f=ye(c,a),'
        'b=s(i?`locks.${c}.${f?"unlock":"lock"}`:`locks.${c}.${f?"locked":"unlocked"}`);return n.jsx("li",{'
        'className:"mr-2.5 inline-block",children:n.jsx(A,{variant:"header",label:b,className:F(f&&"text-style-error/50"),'
        '"data-testid":`lock-${c}`,"data-locked":f||void 0,"aria-disabled":!i,onClick:()=>i&&o.toggleLock(c),children:h})})};'
        'return n.jsxs("div",{className:"flex flex-1 flex-row items-center",children:[n.jsxs("a",{'
        'href:"https://github.com/m1k1o/neko",title:"Github repository",target:"_blank",rel:"noreferrer",'
        'className:"ml-5 flex w-[150px] flex-1 items-center justify-start",children:[n.jsx("img",{src:ke,alt:"n.eko",'
        'className:"mr-2.5 block h-7.5"}),n.jsxs("span",{className:"text-[30px] leading-7.5",children:['
        'n.jsx("b",{className:"font-black",children:"n"}),".eko"]})]}),n.jsxs("ul",{className:"mr-2.5 whitespace-nowrap",'
        'children:[n.jsx("li",{className:"mr-2.5 phone:inline-flex hidden",children:n.jsx(A,{variant:"header",'
        'label:z?"Unmute":"Mute","data-testid":"header-mute","data-muted":z||void 0,'
        'onClick:()=>{z?(e.unmute(),e.play().catch(()=>{})):e.mute()},'
        'children:z?n.jsx(en,{className:"size-4"}):n.jsx(It,{className:"size-4"})})}),'
        'cn&&cm&&n.jsx("li",{className:"mr-2.5 phone:inline-flex hidden",children:n.jsx(A,{variant:"header",'
        'label:s(mo?"controls.mic_off":"controls.mic_on"),"data-testid":"header-mic","data-on":mo||void 0,'
        'onClick:()=>window.__nekoToggleMic?.(),'
        'children:mo?n.jsx(Xs,{className:"size-4"}):n.jsx(Qs,{className:"size-4"})})}),'
        'p("control",n.jsx(Tt,{className:"size-4"})),p("login",ye("login",a)?n.jsx(St,{className:"size-4"}):'
        'n.jsx(Ct,{className:"size-4"})),r.map(({id:c,component:h})=>n.jsx(h,{},c)),n.jsx(Ze,{items:d,'
        'use:c=>c.useBadge??li,children:c=>n.jsx(di,{side:l,unread:c.reduce((h,f)=>h+f,0)})})]})]})}'
    )

    old_li = (
        'function Li({hideControls:s,extraControls:e}){const{t}=V(),{client:o,overlay:i,app:a}=O(),l=ne(),'
        '{admin:r,hosting:d,hosted:p,implicit:c,lockedControls:h,video:f}=k(o.store,Z(P=>({'
        'admin:Y(P),hosting:ie(P),hosted:P.control.host_id!==null,implicit:P.settings.implicit_hosting,'
        'lockedControls:P.settings.locked_controls,video:P.video}))),b=k(a,P=>P.emotes),w=v.useRef(null),'
        '{fullscreen:C,request:N}=Ai(w),_=Ii(),U=Pi(),m=h&&!r,{playing:S,playable:T,muted:z,mutedByAutoplay:K}=f,'
        'G=e?"":"phone:block hidden";return n.jsx("div",{className:"relative h-full w-full",'
        'children:n.jsxs("div",{ref:w,className:"absolute inset-0 flex items-center justify-center bg-black",'
        'children:[n.jsxs("div",{className:"absolute inset-0","data-testid":"player",onMouseEnter:_,'
        'children:[n.jsx(Di,{transport:o.transport}),n.jsx("div",{className:"pointer-events-none absolute inset-0 '
        'overflow-hidden",children:Object.entries(b).map(([P,x])=>n.jsx(Ci,{id:P,type:x},P))}),'
        '!S&&T?n.jsx(A,{label:"Play",className:yt,"data-testid":"player-overlay",'
        'onClick:()=>(o.unmute(),o.play().catch(()=>{})),children:n.jsx(At,{className:"size-[120px]"})}):'
        'S&&z&&K&&n.jsx(A,{label:"Unmute",className:yt,"data-testid":"player-overlay",'
        'onClick:()=>o.unmute(),children:n.jsx(It,{className:"size-[120px]"})})]}),'
        '!C&&!s&&n.jsxs("ul",{className:"absolute top-[15px] right-5",children:['
        'n.jsx("li",{className:"mb-2.5 last:mb-0",children:n.jsx(A,{variant:"video",label:"Fullscreen",onClick:N,'
        'children:n.jsx(sn,{className:"size-4"})})}),'
        'r&&n.jsx("li",{className:"mb-2.5 last:mb-0",children:n.jsxs(is,{children:[n.jsx(as,{asChild:!0,'
        'children:n.jsx(A,{variant:"video",label:"Screen resolution","data-testid":"resolution-open",'
        'children:n.jsx(Rt,{className:"size-4"})})}),n.jsx(Ti,{})]})}),'
        '!m&&!c&&n.jsx("li",{className:F("mb-2.5 last:mb-0",G),children:n.jsx(A,{variant:"video",'
        'label:t(d?"controls.release":"controls.request"),className:F(p&&!d&&"text-style-error/40",'
        '!p&&!d&&"text-text-normal/40"),onClick:()=>T&&l.toggleControl(),children:n.jsx(Tt,{className:"size-4"})})})]})'
    )

    new_li = (
        'function Li({hideControls:s,extraControls:e}){const{t}=V(),{client:o,overlay:i,app:a}=O(),l=ne(),'
        '{admin:r,hosting:d,hosted:p,implicit:c,lockedControls:h,video:f,connected:cn,canShareMedia:cm}=k(o.store,Z(P=>({'
        'admin:Y(P),hosting:ie(P),hosted:P.control.host_id!==null,implicit:P.settings.implicit_hosting,'
        'lockedControls:P.settings.locked_controls,video:P.video,connected:P.connection.status==="connected",'
        'canShareMedia:!!Pe(P)?.profile.can_share_media}))),b=k(a,P=>P.emotes),w=v.useRef(null),'
        '{fullscreen:C,request:N}=Ai(w),_=Ii(),U=Pi(),m=h&&!r,{playing:S,playable:T,muted:z,mutedByAutoplay:K}=f,'
        'G=e?"":"phone:block hidden",mr=v.useRef(null),[mo,ms2]=v.useState(!1),'
        'syncMic=q=>{ms2(q),window.__nekoMicOn=q,window.dispatchEvent(new Event("neko-mic"))},'
        'mx=(q)=>{mr.current&&(mr.current.stop(),mr.current.track?.stop(),mr.current=null,syncMic(!1),q&&Q(t("controls.mic_off"),"Microphone muted"))};'
        'v.useEffect(()=>{!cn&&mx(!1)},[cn]);v.useEffect(()=>()=>mx(!1),[]);'
        'const ml=async(P)=>{P?.stopPropagation?.();if(mr.current)return mx(!0);try{'
        'o.controlling||o.request();'
        'if(!navigator.mediaDevices?.getUserMedia)throw new Error("getUserMedia unavailable in this browser");'
        'const M=await navigator.mediaDevices.getUserMedia({audio:!0}),he=M.getAudioTracks()[0];'
        'if(!he)throw new Error("No audio input track returned");'
        'mr.current={track:he,stop:o.shareMedia(M)},syncMic(!0),Q(t("controls.mic_on"),"Microphone live")}catch(M){'
        'const mg2=M?.message||String(M);console.error("[neko-mobile] mic error",M),Q(t("controls.mic_error"),mg2,"error"),Oe(a,t("controls.mic_error"),mg2)}};'
        'window.__nekoToggleMic=ml;'
        'return n.jsx("div",{className:"relative h-full w-full",'
        'children:n.jsxs("div",{ref:w,className:"absolute inset-0 flex items-center justify-center bg-black",'
        'children:[n.jsxs("div",{className:"absolute inset-0","data-testid":"player",onMouseEnter:_,'
        'children:[n.jsx(Di,{transport:o.transport}),n.jsx("div",{className:"pointer-events-none absolute inset-0 '
        'overflow-hidden",children:Object.entries(b).map(([P,x])=>n.jsx(Ci,{id:P,type:x},P))}),'
        '!S&&T?n.jsx(A,{label:"Play",className:yt,"data-testid":"player-overlay",'
        'onClick:()=>(o.unmute(),o.play().catch(()=>{}),o.implicitControl&&!o.controlling&&!o.state.control.host_id&&o.request()),'
        'children:n.jsx(At,{className:"size-[120px]"})}):'
        'S&&z&&K&&n.jsx(A,{label:"Unmute",className:yt,"data-testid":"player-overlay",'
        'onClick:()=>(o.unmute(),o.implicitControl&&!o.controlling&&!o.state.control.host_id&&o.request()),'
        'children:n.jsx(It,{className:"size-[120px]"})})]}),'
        '!C&&!s&&n.jsxs("ul",{className:"absolute top-[15px] right-5 z-50",'
        'onTouchStart:P=>P.stopPropagation(),onPointerDown:P=>P.stopPropagation(),children:['
        'n.jsx("li",{className:"mb-2.5 last:mb-0",children:n.jsx(A,{variant:"video",label:"Fullscreen",onClick:N,'
        'children:n.jsx(sn,{className:"size-4"})})}),'
        'r&&n.jsx("li",{className:"mb-2.5 last:mb-0",children:n.jsxs(is,{children:[n.jsx(as,{asChild:!0,'
        'children:n.jsx(A,{variant:"video",label:"Screen resolution","data-testid":"resolution-open",'
        'children:n.jsx(Rt,{className:"size-4"})})}),n.jsx(Ti,{})]})}),'
        'n.jsx("li",{className:F("mb-2.5 last:mb-0",G),children:n.jsx(A,{variant:"video",'
        'label:z?"Unmute":"Mute","data-testid":"mobile-mute","data-muted":z||void 0,'
        'className:F(z&&"text-style-error"),onClick:P=>{P.stopPropagation(),z?(o.unmute(),o.play().catch(()=>{})):o.mute()},'
        'children:z?n.jsx(en,{className:"size-4"}):n.jsx(It,{className:"size-4"})})}),'
        'cn&&cm&&n.jsx("li",{className:F("mb-2.5 last:mb-0",G),children:n.jsx(A,{variant:"video",'
        'label:t(mo?"controls.mic_off":"controls.mic_on"),"data-testid":"mobile-mic","data-on":mo||void 0,'
        'onClick:ml,children:mo?n.jsx(Xs,{className:"size-4"}):n.jsx(Qs,{className:"size-4"})})}),'
        '!m&&!c&&n.jsx("li",{className:F("mb-2.5 last:mb-0",G),children:n.jsx(A,{variant:"video",'
        'label:t(d?"controls.release":"controls.request"),className:F(p&&!d&&"text-style-error/40",'
        '!p&&!d&&"text-text-normal/40"),onClick:()=>T&&l.toggleControl(),children:n.jsx(Tt,{className:"size-4"})})})]})'
    )

    renames: dict[str, str] = {}
    for js_path in candidates:
        js = js_path.read_text("utf-8")
        if old_touch_block not in js:
            continue
        assert js.count(old_touch_block) == 1, f"Expected 1 onTouch/onControl match in {js_path}"
        assert js.count(old_set_muted) == 1, f"Expected 1 setMuted match in {js_path}"
        assert js.count(old_ci) == 1, f"Expected 1 ci() match in {js_path}"
        assert js.count(old_li) == 1, f"Expected 1 Li() match in {js_path}"
        js = js.replace(old_touch_block, new_touch_block, 1)
        js = js.replace(old_set_muted, new_set_muted, 1)
        js = js.replace(old_ci, new_ci, 1)
        js = js.replace(old_li, new_li, 1)
        js_hash = hashlib.sha256(js.encode("utf-8")).hexdigest()[:8]
        new_path = js_path.with_name(f"index-{js_hash}.js")
        new_path.write_text(js, "utf-8")
        if new_path != js_path:
            js_path.unlink()
        renames[js_path.name] = new_path.name
        print(f"Patched Neko UI bundle: {js_path.name} -> {new_path.name}")

    if not renames:
        raise RuntimeError("Did not find expected Neko bundle patterns in /var/www/assets/index-*.js")
    return renames


if __name__ == "__main__":
    js_renames = patch_app_js()
    patch_index_html(js_renames)

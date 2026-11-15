"""Patch Neko's static frontend for responsive mobile viewport and reliable iOS touch control."""

from pathlib import Path

WWW_DIR = Path("/var/www")


def patch_index_html() -> None:
    index_path = WWW_DIR / "index.html"
    html = index_path.read_text("utf-8")

    old_vp = 'content="width=device-width,initial-scale=1.0"'
    new_vp = 'content="width=device-width,initial-scale=1.0,maximum-scale=1.0,viewport-fit=cover"'
    if old_vp in html:
        html = html.replace(old_vp, new_vp, 1)
    elif new_vp not in html:
        raise RuntimeError("viewport meta tag not found in index.html")

    if "mobile-fix.css" not in html:
        assert "</head>" in html, "</head> not found in index.html"
        html = html.replace("</head>", '    <link rel="stylesheet" href="./mobile-fix.css">\n  </head>', 1)

    index_path.write_text(html, "utf-8")


def patch_app_js() -> None:
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

    old_play = 'onClick:()=>(o.unmute(),o.play().catch(()=>{}))'
    new_play = 'onClick:()=>(o.unmute(),o.play().catch(()=>{}),o.implicitControl&&!o.controlling&&!o.state.control.host_id&&o.request())'
    old_unmute = 'onClick:()=>o.unmute()'
    new_unmute = 'onClick:()=>(o.unmute(),o.implicitControl&&!o.controlling&&!o.state.control.host_id&&o.request())'

    patched = False
    for js_path in candidates:
        js = js_path.read_text("utf-8")
        if old_touch_block not in js:
            continue
        assert js.count(old_touch_block) == 1, f"Expected 1 onTouch/onControl match in {js_path}"
        assert js.count(old_play) == 1, f"Expected 1 Play overlay match in {js_path}"
        assert js.count(old_unmute) == 1, f"Expected 1 Unmute overlay match in {js_path}"
        js = js.replace(old_touch_block, new_touch_block, 1)
        js = js.replace(old_play, new_play, 1)
        js = js.replace(old_unmute, new_unmute, 1)
        js_path.write_text(js, "utf-8")
        patched = True
        print(f"Patched Neko UI bundle: {js_path}")

    if not patched:
        raise RuntimeError("Did not find expected Neko onTouch/onControl block in /var/www/assets/index-*.js")


if __name__ == "__main__":
    patch_index_html()
    patch_app_js()

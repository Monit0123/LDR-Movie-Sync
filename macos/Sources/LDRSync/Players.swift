import AVFoundation
import QuartzCore
import SwiftUI
import WebKit

// MARK: - Native playback (AVPlayer)

struct NativePlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> VideoHostView {
        let view = VideoHostView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateNSView(_ nsView: VideoHostView, context: Context) {
        if nsView.playerLayer.player !== player {
            nsView.playerLayer.player = player
        }
    }
}

final class VideoHostView: NSView {
    let playerLayer = AVPlayerLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.addSublayer(playerLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }

    override var isOpaque: Bool { true }
}

// MARK: - Contained browser (WKWebView + shared bridge)

struct WebPlayerView: NSViewRepresentable {
    @ObservedObject var store: SyncStore

    func makeCoordinator() -> Coordinator {
        Coordinator(store: store)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Let us start playback from a timestamp without a click.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = true

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "flickSync")
        configuration.userContentController = controller

        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.layer?.backgroundColor = NSColor.black.cgColor

        context.coordinator.webView = web
        if let url = store.webURL {
            context.coordinator.loadedURL = url.absoluteString
            web.load(URLRequest(url: url))
        }
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator

        if let url = store.webURL, coordinator.loadedURL != url.absoluteString {
            coordinator.loadedURL = url.absoluteString
            web.load(URLRequest(url: url))
        }

        if let command = store.webCommand, coordinator.lastCommand != command.id {
            coordinator.lastCommand = command.id
            coordinator.apply(command)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let store: SyncStore
        weak var webView: WKWebView?
        var loadedURL: String?
        var lastCommand: UUID?

        init(store: SyncStore) {
            self.store = store
        }

        // Page reports play/pause/seek/time/detected.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let payload = message.body as? String,
                  let data = payload.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            let store = self.store
            Task { @MainActor in store.ingestWebEvent(json) }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            inject()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            inject()
            // Platform players mount their <video> late.
            for delay in [0.5, 1.5, 3.0, 5.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.inject()
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            let store = self.store
            Task { @MainActor in store.flash("That page would not load") }
        }

        func inject() {
            webView?.evaluateJavaScript(Self.script(), completionHandler: nil)
        }

        func apply(_ command: WebCommand) {
            let js = """
            try{window.__flicksync&&window.__flicksync.apply({
              cmd:'\(command.action)',position:\(command.position),tolerance:\(command.tolerance)
            });}catch(e){}
            """
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        /// shared/bridge.js from the app bundle, with an inline fallback.
        static func script() -> String {
            if let url = Bundle.main.url(forResource: "bridge", withExtension: "js"),
               let text = try? String(contentsOf: url, encoding: .utf8),
               !text.isEmpty {
                return text
            }
            // Running straight from `swift run` during development.
            let local = URL(fileURLWithPath: "shared/bridge.js")
            if let text = try? String(contentsOf: local, encoding: .utf8), !text.isEmpty {
                return text
            }
            return FALLBACK
        }

        private static let FALLBACK = """
        (function(){
          if(window.__flicksync)return;
          var S={video:null,last:0};
          function post(o){try{window.webkit.messageHandlers.flickSync.postMessage(JSON.stringify(o));}catch(e){}}
          function send(t,x){var v=S.video;var o={type:t,position:v?v.currentTime:0,duration:v?v.duration:0,paused:v?v.paused:true,src:v?(v.currentSrc||v.src||''):'',title:document.title,url:location.href};if(x)for(var k in x)o[k]=x[k];post(o);}
          function attach(v){if(!v||v.__b)return;v.__b=true;
            v.addEventListener('play',function(){send('play');});
            v.addEventListener('pause',function(){if(!v.ended)send('pause');});
            v.addEventListener('seeked',function(){send('seeked');});
            v.addEventListener('loadedmetadata',function(){send('ready');});
            v.addEventListener('timeupdate',function(){var n=Date.now();if(n-S.last<700)return;S.last=n;send('time');});}
          function pick(){var l=[].slice.call(document.querySelectorAll('video'));if(!l.length)return null;l.sort(function(a,b){return (b.clientWidth*b.clientHeight)-(a.clientWidth*a.clientHeight);});return l[0];}
          function scan(){var v=pick();if(v&&v!==S.video){S.video=v;attach(v);send('detected');}else if(v)attach(v);}
          window.__flicksync={scan:scan,apply:function(c){scan();var v=S.video||pick();if(!v)return false;
            try{if(c.position!==undefined&&Math.abs(v.currentTime-c.position)>(c.tolerance||0.35))v.currentTime=c.position;
            if(c.cmd==='play')v.play();else if(c.cmd==='pause')v.pause();return true;}catch(e){return false;}}};
          setInterval(scan,700);scan();
        })();
        """
    }
}

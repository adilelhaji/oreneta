//go:build production

package main

// contentSecurityPolicy locks the production webview down to same-origin assets,
// allowing only what the bundle actually needs: inline styles (Tailwind v4 injects
// a <style> and components use inline style attributes), WebAssembly compilation
// for the on-device grammar checker and translator ('wasm-unsafe-eval', which
// allows no JavaScript eval), and their workers, which Harper starts from a
// blob: URL. Fonts are bundled, so no font host is allowed.
// All app data flows through Wails IPC, not the network, so connect-src stays 'self'.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"worker-src 'self' blob:; " +
	"style-src 'self' 'unsafe-inline'; " +
	"font-src 'self'; " +
	"img-src 'self' data: blob: http: https:; " +
	"media-src 'self' data: blob: http: https:; " +
	"connect-src 'self'; " +
	"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

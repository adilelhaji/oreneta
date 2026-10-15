package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
)

type clipboardImageResult struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int    `json:"size"`
	Data     string `json:"data"`
}

var preferredClipboardImageTypes = []struct {
	mime string
	ext  string
}{
	{"image/png", "png"},
	{"image/jpeg", "jpg"},
	{"image/jpg", "jpg"},
	{"image/gif", "gif"},
	{"image/webp", "webp"},
	{"image/bmp", "bmp"},
}

// readClipboardImage tries to read an image off the system clipboard. It
// returns empty bytes when no image is available so the frontend can keep normal
// text paste behavior.
func readClipboardImage() ([]byte, string, string, error) {
	log.Printf("[composer-paste] native readClipboardImage os=%s", runtime.GOOS)
	if runtime.GOOS == "darwin" {
		data, ext, err := readClipboardImageDarwin()
		if len(data) == 0 || err != nil {
			return data, "", ext, err
		}
		if ext == "jpg" {
			return data, "image/jpeg", ext, nil
		}
		return data, "image/png", ext, nil
	}

	if _, err := exec.LookPath("wl-paste"); err == nil {
		log.Printf("[composer-paste] native using wl-paste")
		out, err := exec.Command("wl-paste", "--list-types").Output()
		if err == nil {
			types := strings.Split(strings.TrimSpace(string(out)), "\n")
			log.Printf("[composer-paste] native wl-paste types=%q", types)
			for _, p := range preferredClipboardImageTypes {
				if hasClipboardType(types, p.mime) {
					data, err := exec.Command("wl-paste", "--type", p.mime).Output()
					if err != nil {
						return nil, "", "", fmt.Errorf("wl-paste %s: %w", p.mime, err)
					}
					if len(data) == 0 {
						continue
					}
					log.Printf("[composer-paste] native wl-paste image mime=%s bytes=%d", p.mime, len(data))
					return data, p.mime, p.ext, nil
				}
			}
			log.Printf("[composer-paste] native wl-paste no supported image type")
			return nil, "", "", nil
		}
		log.Printf("[composer-paste] native wl-paste list-types failed: %v", err)
	}

	if _, err := exec.LookPath("xclip"); err == nil {
		log.Printf("[composer-paste] native using xclip")
		out, err := exec.Command("xclip", "-selection", "clipboard", "-t", "TARGETS", "-o").Output()
		if err == nil {
			types := strings.Split(strings.TrimSpace(string(out)), "\n")
			log.Printf("[composer-paste] native xclip targets=%q", types)
			for _, p := range preferredClipboardImageTypes {
				if hasClipboardType(types, p.mime) {
					data, err := exec.Command("xclip", "-selection", "clipboard", "-t", p.mime, "-o").Output()
					if err != nil {
						return nil, "", "", fmt.Errorf("xclip %s: %w", p.mime, err)
					}
					if len(data) == 0 {
						continue
					}
					log.Printf("[composer-paste] native xclip image mime=%s bytes=%d", p.mime, len(data))
					return data, p.mime, p.ext, nil
				}
			}
			log.Printf("[composer-paste] native xclip no supported image type")
			return nil, "", "", nil
		}
		log.Printf("[composer-paste] native xclip TARGETS failed: %v", err)
	}

	log.Printf("[composer-paste] native no clipboard image helper found or no image available")
	return nil, "", "", nil
}

func hasClipboardType(types []string, want string) bool {
	for _, t := range types {
		if strings.EqualFold(strings.TrimSpace(t), want) {
			return true
		}
	}
	return false
}

func (a *App) readClipboardImageAttachment(map[string]any) (any, error) {
	raw, mime, ext, err := readClipboardImage()
	if err != nil {
		log.Printf("[composer-paste] native read failed: %v", err)
		return nil, err
	}
	if len(raw) == 0 {
		log.Printf("[composer-paste] native no image")
		return nil, nil
	}
	if mime == "" {
		mime = "image/" + ext
	}
	if ext == "" {
		ext = "png"
	}
	return clipboardImageResult{
		Filename: fmt.Sprintf("pasted-image-%d.%s", time.Now().UnixMilli(), ext),
		Mime:     mime,
		Size:     len(raw),
		Data:     base64.StdEncoding.EncodeToString(raw),
	}, nil
}

// resolveMediaPath maps a `/media/<key>` key to an on-disk path, path-cleaned
// and confined to the media root to block traversal (same guard as
// saveAttachment / readAttachment).
func resolveMediaPath(key string) (string, error) {
	if key == "" {
		return "", errors.New("missing attachment key")
	}
	for _, part := range strings.Split(filepath.ToSlash(key), "/") {
		if part == ".." {
			return "", errors.New("invalid attachment key")
		}
	}
	root := mediaDir()
	src := filepath.Join(root, filepath.Clean("/"+key))
	if rel, err := filepath.Rel(root, src); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", errors.New("invalid attachment key")
	}
	return src, nil
}

func imageMimeForPath(path string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	if ext == "jpeg" {
		ext = "jpg"
	}
	for _, p := range preferredClipboardImageTypes {
		if p.ext == ext {
			return p.mime
		}
	}
	return "image/png"
}

// copyImage puts an attachment stored under the media dir onto the system
// clipboard as an image. The webview's native "Copy Image" is inert in the
// Wails webview, so the gallery's custom context menu calls this instead. It
// mirrors readClipboardImage in reverse — going through NSPasteboard on macOS
// and wl-copy / xclip elsewhere rather than the webview clipboard, which can't
// reliably carry images here.
func (a *App) copyImage(payload map[string]any) (any, error) {
	key, _ := payload["key"].(string)
	src, err := resolveMediaPath(key)
	if err != nil {
		return nil, err
	}
	if err := copyImageToClipboard(src); err != nil {
		log.Printf("[gallery-copy] failed: %v", err)
		return nil, err
	}
	return map[string]any{"copied": true}, nil
}

func copyImageToClipboard(path string) error {
	mime := imageMimeForPath(path)
	if runtime.GOOS == "darwin" {
		return copyImageToClipboardDarwin(path, mime)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if _, err := exec.LookPath("wl-copy"); err == nil {
		cmd := exec.Command("wl-copy", "--type", mime)
		cmd.Stdin = bytes.NewReader(data)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("wl-copy: %w", err)
		}
		return nil
	}
	if _, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command("xclip", "-selection", "clipboard", "-t", mime, "-i")
		cmd.Stdin = bytes.NewReader(data)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("xclip: %w", err)
		}
		return nil
	}
	return errors.New("no clipboard helper found (install wl-clipboard or xclip)")
}

func (a *App) writeMediaFile(payload map[string]any) (any, error) {
	dataStr, _ := payload["data"].(string)
	filename, _ := payload["filename"].(string)
	if dataStr == "" {
		return nil, errors.New("missing data")
	}
	raw, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}

	root := mediaDir()
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, fmt.Errorf("create media dir: %w", err)
	}

	key := uuid.New().String()
	if ext := filepath.Ext(filename); ext != "" {
		key = key + ext
	} else {
		key = key + ".png"
	}

	dest := filepath.Join(root, key)
	if err := os.WriteFile(dest, raw, 0644); err != nil {
		return nil, fmt.Errorf("write media file: %w", err)
	}

	// Served by mediaHandler at this path; both sides agree on mediaDir().
	return "/media/" + key, nil
}

func (a *App) writeAvatarFile(payload map[string]any) (any, error) {
	accountID, _ := payload["id"].(string)
	if accountID == "" {
		accountID, _ = payload["account_id"].(string)
	}
	dataStr, _ := payload["data"].(string)
	if accountID == "" {
		return nil, errors.New("account id required")
	}
	if dataStr == "" {
		return nil, errors.New("missing data")
	}
	raw, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}
	if len(raw) > 5*1024*1024 {
		return nil, errors.New("avatar image must be 5 MB or smaller")
	}

	extByMime := map[string]string{
		"image/png":  ".png",
		"image/jpeg": ".jpg",
		"image/gif":  ".gif",
		"image/webp": ".webp",
	}
	mime := http.DetectContentType(raw)
	ext, ok := extByMime[mime]
	if !ok {
		return nil, errors.New("avatar must be a PNG, JPEG, GIF, or WebP image")
	}

	safeAccount := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, accountID)
	if safeAccount == "" {
		return nil, errors.New("invalid account id")
	}

	root := filepath.Join(mediaDir(), "avatars", safeAccount)
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, fmt.Errorf("create avatar dir: %w", err)
	}

	key := uuid.New().String() + ext
	dest := filepath.Join(root, key)
	if err := os.WriteFile(dest, raw, 0644); err != nil {
		return nil, fmt.Errorf("write avatar file: %w", err)
	}

	return map[string]any{"url": "/media/avatars/" + safeAccount + "/" + key}, nil
}

func (a *App) writeChatWallpaperFile(payload map[string]any) (any, error) {
	accountID, _ := payload["id"].(string)
	if accountID == "" {
		accountID, _ = payload["account_id"].(string)
	}
	dataStr, _ := payload["data"].(string)
	if accountID == "" {
		return nil, errors.New("account id required")
	}
	if dataStr == "" {
		return nil, errors.New("missing data")
	}
	raw, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}
	if len(raw) > 10*1024*1024 {
		return nil, errors.New("wallpaper image must be 10 MB or smaller")
	}

	extByMime := map[string]string{
		"image/png":  ".png",
		"image/jpeg": ".jpg",
		"image/gif":  ".gif",
		"image/webp": ".webp",
	}
	mime := http.DetectContentType(raw)
	ext, ok := extByMime[mime]
	if !ok {
		return nil, errors.New("wallpaper must be a PNG, JPEG, GIF, or WebP image")
	}

	safeAccount := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, accountID)
	if safeAccount == "" {
		return nil, errors.New("invalid account id")
	}

	root := filepath.Join(mediaDir(), "wallpapers", safeAccount)
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, fmt.Errorf("create wallpaper dir: %w", err)
	}

	key := uuid.New().String() + ext
	dest := filepath.Join(root, key)
	if err := os.WriteFile(dest, raw, 0644); err != nil {
		return nil, fmt.Errorf("write wallpaper file: %w", err)
	}

	return map[string]any{"url": "/media/wallpapers/" + safeAccount + "/" + key}, nil
}

// pruneComposerMedia deletes loose inline-image files written by writeMediaFile
// that are no longer referenced by any persisted compose draft. The frontend
// passes the set of `/media/<key>` keys it still references (scanned from
// persisted draft HTML on boot); every other regular file in the media root is
// an orphan from a discarded or sent draft and gets removed. Per-account
// attachment subdirectories (written by the sidecar) are never touched — only
// regular files at the root, which are exclusively writeMediaFile's output.
func (a *App) pruneComposerMedia(payload map[string]any) (any, error) {
	keep := map[string]bool{}
	if raw, ok := payload["keys"].([]any); ok {
		for _, k := range raw {
			if s, ok := k.(string); ok && s != "" {
				keep[s] = true
			}
		}
	}

	root := mediaDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"removed": 0}, nil
		}
		return nil, fmt.Errorf("read media dir: %w", err)
	}

	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || keep[entry.Name()] {
			continue
		}
		if err := os.Remove(filepath.Join(root, entry.Name())); err == nil {
			removed++
		}
	}
	return map[string]any{"removed": removed}, nil
}

// isLocalAvatar reports whether a picture address is none, or a copy kept on
// this computer. Those are the only two things an account picture may be.
func isLocalAvatar(value string) bool {
	return value == "" || strings.HasPrefix(value, "/media/")
}

// isRemoteURL reports whether a picture address points at the network. The
// scheme is read without regard to case.
func isRemoteURL(value string) bool {
	value = strings.TrimSpace(value)
	for _, scheme := range []string{"http://", "https://"} {
		if len(value) >= len(scheme) && strings.EqualFold(value[:len(scheme)], scheme) {
			return true
		}
	}
	return false
}

// saveAvatar keeps a copy of an account picture on this computer, under
// mediaDir/avatars/<safeAccount>, and returns its local media URL (for
// example "/media/avatars/account-id/uuid.ext"). A picture that is empty or
// already local comes back as it is.
//
// A remote picture is fetched through the account route (its own proxy, direct,
// or the app proxy). When that fails it is an error, and the address is never
// handed back as the picture: the web view would load it directly, without the
// proxy, every time it drew the avatar (#194). The caller keeps the address
// apart, only to try again. Any other kind of address (a data: URL, one that
// starts with //) is refused for the same reason.
func (a *App) saveAvatar(accountID, avatarURL string) (string, error) {
	if isLocalAvatar(avatarURL) {
		return avatarURL, nil
	}
	if !isRemoteURL(avatarURL) {
		return "", errors.New("unsupported picture address")
	}
	avatarURL = strings.TrimSpace(avatarURL)

	safeAccount := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, accountID)
	if safeAccount == "" {
		return "", errors.New("account id required")
	}

	// A proxy that is set but unusable is an error here, not a direct fetch.
	client, err := a.httpClient(accountID, 10*time.Second)
	if err != nil {
		return "", fmt.Errorf("download avatar skipped: %w", err)
	}
	resp, err := client.Get(avatarURL)
	if err != nil {
		return "", fmt.Errorf("download avatar failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download avatar returned status: %s", resp.Status)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024+1))
	if err != nil {
		return "", fmt.Errorf("read avatar body failed: %w", err)
	}
	if len(raw) > 5*1024*1024 {
		return "", errors.New("avatar image too large")
	}

	extByMime := map[string]string{
		"image/png":  ".png",
		"image/jpeg": ".jpg",
		"image/gif":  ".gif",
		"image/webp": ".webp",
	}
	mime := http.DetectContentType(raw)
	ext, ok := extByMime[mime]
	if !ok {
		ext = ".jpg"
	}

	root := filepath.Join(mediaDir(), "avatars", safeAccount)
	if err := os.MkdirAll(root, 0755); err != nil {
		return "", fmt.Errorf("create avatar dir failed: %w", err)
	}

	key := uuid.New().String() + ext
	if err := os.WriteFile(filepath.Join(root, key), raw, 0644); err != nil {
		return "", fmt.Errorf("write avatar file failed: %w", err)
	}

	return "/media/avatars/" + safeAccount + "/" + key, nil
}

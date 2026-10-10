//go:build integration

package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A throwaway Radicale server for CardDAV (and CalDAV) integration tests,
// beside the maddy one for mail. Radicale is a small standards server with
// htpasswd authentication and filesystem storage: enough to prove the
// client's discovery, reads, writes and failure handling against a real
// WebDAV implementation, without an account anywhere.
//
// This is isolated protocol evidence, not provider certification: Google,
// iCloud, Nextcloud and Exchange each have their own quirks and limits.
const radicaleImage = "tomsquest/docker-radicale:3.5.4.0"

const radicaleUser = "alice"

// Radicale's configuration: one htpasswd user, plain passwords (a test
// fixture, never a deployment), owner-only rights so a wrong user sees
// nothing rather than everything.
const radicaleConf = `[server]
hosts = 0.0.0.0:5232

[auth]
type = htpasswd
htpasswd_filename = /config/users
htpasswd_encryption = plain

[storage]
filesystem_folder = /data/collections

[rights]
type = owner_only
`

type radicaleServer struct {
	port      int
	container string
	stopped   bool
}

// startRadicale launches the container and waits until it answers an
// authenticated PROPFIND for the test user's home collection.
func startRadicale(t *testing.T) *radicaleServer {
	t.Helper()
	docker := dockerBin(t)

	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config"), []byte(radicaleConf), 0o644); err != nil {
		t.Fatal(err)
	}
	users := fmt.Sprintf("%s:%s\n", radicaleUser, testPassword)
	if err := os.WriteFile(filepath.Join(configDir, "users"), []byte(users), 0o644); err != nil {
		t.Fatal(err)
	}

	server := &radicaleServer{port: freePort(t)}
	// Storage lives in an anonymous volume the image's entrypoint hands to
	// its own user, removed with the container. A bind mount would leave
	// files owned by that user in the test's temporary directory, which the
	// test process cannot delete on a runner where it is not root.
	server.container = runCmd(t, docker, "run", "-d", "--rm",
		"-v", configDir+":/config:ro,Z",
		"-v", "/data",
		"-e", "TAKE_FILE_OWNERSHIP=true",
		"-p", fmt.Sprintf("127.0.0.1:%d:5232", server.port),
		radicaleImage)
	t.Cleanup(func() {
		if server.stopped {
			return
		}
		logs, err := exec.Command(docker, "logs", server.container).CombinedOutput()
		if err == nil {
			t.Logf("--- RADICALE CONTAINER LOGS ---\n%s\n--- END RADICALE LOGS ---", string(logs))
		}
		server.stop(t)
	})

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, _ := server.dav(t, "PROPFIND", server.userURL(), "", map[string]string{"Depth": "0"})
		if status == http.StatusMultiStatus {
			return server
		}
		time.Sleep(300 * time.Millisecond)
	}
	logs, _ := exec.Command(docker, "logs", server.container).CombinedOutput()
	t.Fatalf("radicale did not become ready on port %d\ncontainer logs:\n%s", server.port, logs)
	return nil
}

// stop halts the container without removing its data, standing in for a
// server that is unreachable for a while.
func (s *radicaleServer) stop(t *testing.T) {
	t.Helper()
	if s.stopped {
		return
	}
	s.stopped = true
	runCmd(t, dockerBin(t), "stop", "-t", "2", s.container)
}

func (s *radicaleServer) baseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/", s.port)
}

func (s *radicaleServer) userURL() string {
	return s.baseURL() + radicaleUser + "/"
}

func (s *radicaleServer) bookURL(name string) string {
	return s.userURL() + name + "/"
}

// dav sends one authenticated WebDAV request as the test user and returns the
// status and body. A connection error is reported as status 0, which is what
// a stopped server looks like from here.
func (s *radicaleServer) dav(t *testing.T, method, url, body string, headers map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth(radicaleUser, testPassword)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(data)
}

// createAddressBook makes a CardDAV collection under the test user via the
// extended MKCOL that Radicale (and RFC 5689 servers) accept.
func (s *radicaleServer) createAddressBook(t *testing.T, name, displayName string) {
	t.Helper()
	body := `<?xml version="1.0" encoding="UTF-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
    <D:displayname>` + displayName + `</D:displayname>
  </D:prop></D:set>
</D:mkcol>`
	status, reply := s.dav(t, "MKCOL", s.bookURL(name), body, map[string]string{"Content-Type": "application/xml"})
	if status != http.StatusCreated {
		t.Fatalf("MKCOL %s: HTTP %d %s", name, status, reply)
	}
}

// putVCard stores one contact in a book, creating or replacing it.
func (s *radicaleServer) putVCard(t *testing.T, book, uid, fullName, email string) {
	t.Helper()
	vcard := "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:" + uid + "\r\nFN:" + fullName +
		"\r\nN:" + fullName + ";;;;\r\nEMAIL;TYPE=WORK:" + email + "\r\nEND:VCARD\r\n"
	status, reply := s.dav(t, "PUT", s.bookURL(book)+uid+".vcf", vcard, map[string]string{"Content-Type": "text/vcard"})
	if status != http.StatusCreated && status != http.StatusNoContent {
		t.Fatalf("PUT %s: HTTP %d %s", uid, status, reply)
	}
}

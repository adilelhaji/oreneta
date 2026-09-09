package main

type Account struct {
	ID                string  `json:"id"`
	Email             string  `json:"email"`
	DisplayName       string  `json:"display_name"`
	SenderName        string  `json:"sender_name"`
	AvatarURL         string  `json:"avatar_url,omitempty"`
	Provider          string  `json:"provider"`
	AuthType          string  `json:"auth_type"`
	IMAPHost          string  `json:"imap_host"`
	IMAPPort          uint16  `json:"imap_port"`
	SMTPHost          string  `json:"smtp_host"`
	SMTPPort          uint16  `json:"smtp_port"`
	TLS               bool    `json:"tls"`
	StartTLS          bool    `json:"starttls"`
	SMTPTLS           bool    `json:"smtp_tls"`
	SMTPStartTLS      bool    `json:"smtp_starttls"`
	EWSURL            string  `json:"ews_url,omitempty"`
	LoadRemoteImages  bool    `json:"load_remote_images"`
	ConversationHTML  bool    `json:"conversation_html"`
	SaveSentCopy      *bool   `json:"save_sent_copy"`
	ChatWallpaper     any     `json:"chat_wallpaper,omitempty"`
	IncludedInUnified bool    `json:"included_in_unified"`
	Muted             bool    `json:"muted"`
	Paused            bool    `json:"paused"`
	NeedsReconnect    bool    `json:"needs_reconnect,omitempty"`
	FeedURL           string  `json:"feed_url,omitempty"`
	AccessToken       string  `json:"access_token,omitempty"`
	RefreshToken      string  `json:"refresh_token,omitempty"`
	TokenExpiresAt    int64   `json:"token_expires_at,omitempty"`
	SortOrder         int     `json:"sort_order"`
	Aliases           []Alias `json:"aliases,omitempty"`
	// Signature is the per-account override ({mode, html}); absent means the
	// account follows the app-wide signature. Passed through untyped, like
	// Proxy and ChatWallpaper — the engine owns its shape and validates it.
	Signature any `json:"signature,omitempty"`
	// Proxy is passed through untyped: the engine owns its shape, and the
	// bridge has no reason to interpret it.
	Proxy any `json:"proxy,omitempty"`
	// CertPin and SMTPCertPin are the server certificates this account
	// accepted, if any, so a reconnect keeps them instead of re-asking.
	CertPin     string `json:"cert_pin,omitempty"`
	SMTPCertPin string `json:"smtp_cert_pin,omitempty"`
}

// Alias is a send-as identity for an account: an address the user owns plus an
// optional From display name (blank falls back to the account's sender name).
type Alias struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type Folder struct {
	ParentID  *string `json:"parent_id,omitempty"`
	ID        string  `json:"id"`
	AccountID string  `json:"account_id"`
	Name      string  `json:"name"`
	Role      string  `json:"role"`
	Delimiter string  `json:"delimiter"`
	Unread    uint32  `json:"unread"`
}

type Message struct {
	ID         string `json:"id"`
	AccountID  string `json:"account_id"`
	FolderID   string `json:"folder_id"`
	FolderRole string `json:"folder_role,omitempty"`
	ThreadID   string `json:"thread_id"`
	FromName   string `json:"from_name"`
	FromAddr   string `json:"from_addr"`
	To         string `json:"to"`
	ReplyTo    string `json:"reply_to,omitempty"`
	Cc         string `json:"cc,omitempty"`
	Bcc        string `json:"bcc,omitempty"`
	MessageID  string `json:"message_id,omitempty"`
	References string `json:"references,omitempty"`
	Subject    string `json:"subject"`
	Preview    string `json:"preview"`
	Body       string `json:"body"`
	BodyHTML   string `json:"body_html,omitempty"`
	Date       int64  `json:"date"`
	// Outgoing is classified by the core (own address or Sent-folder
	// provenance), so alias-sent mail renders as sent-by-me even when the
	// alias isn't configured in Oreneta.
	Outgoing    bool   `json:"outgoing,omitempty"`
	Unread      bool   `json:"unread"`
	UnreadCount uint32 `json:"unread_count,omitempty"`
	// MessageCount is every message in the thread, read or not; 0 when the
	// core did not group (raw message rows, RSS items).
	MessageCount   uint32 `json:"message_count,omitempty"`
	Starred        bool   `json:"starred"`
	HasDraft       bool   `json:"has_draft,omitempty"`
	HasAttachments bool   `json:"has_attachments"`
	// Labels are ids of the reader's own local labels; the interface paints
	// them from its copy of the label set.
	Labels []string `json:"labels,omitempty"`
	// Priority is a pointer because absent and false are different answers: a
	// message nobody has judged is not a message judged unimportant, and a
	// plain bool would tell the interface the second when the truth is the
	// first.
	Priority *bool `json:"priority,omitempty"`
	// Protection is what the message's own structure declares: "pgpEncrypted",
	// "pgpSigned", "smimeEnveloped" and so on, empty when none. A claim, not a
	// verdict: whether a signature is good is answered separately.
	Protection       string `json:"protection,omitempty"`
	Attachments      any    `json:"attachments,omitempty"`
	OriginalThreadID string `json:"original_thread_id,omitempty"`
	// RecipientOverflow is the count of additional recipients beyond the one shown
	// on an outbound thread card (for a "+N" hint); 0 for inbound/single-recipient.
	RecipientOverflow uint32 `json:"recipient_overflow,omitempty"`
}

// AddEWSAccountRequest sets up an Exchange account. EWS carries mail and
// submission over one HTTPS endpoint, so there are no host/port pairs and no
// TLS mode to choose — the URL says it all.
type AddEWSAccountRequest struct {
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	SenderName  string `json:"sender_name"`
	// Full EWS endpoint, e.g. https://mail.example.org/EWS/Exchange.asmx.
	EWSURL   string `json:"ews_url"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type AddPasswordAccountRequest struct {
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	SenderName   string `json:"sender_name"`
	IMAPHost     string `json:"imap_host"`
	IMAPPort     uint16 `json:"imap_port"`
	SMTPHost     string `json:"smtp_host"`
	SMTPPort     uint16 `json:"smtp_port"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	TLS          *bool  `json:"tls"`
	StartTLS     *bool  `json:"starttls"`
	SMTPTLS      *bool  `json:"smtp_tls"`
	SMTPStartTLS *bool  `json:"smtp_starttls"`
	// Hex SHA-256 of the server certificates the user inspected and accepted,
	// for servers whose certificate cannot be validated normally (a local
	// bridge with a self-signed leaf). Empty for everything else, and separate
	// per server: the two can be different daemons.
	CertPin     string `json:"cert_pin"`
	SMTPCertPin string `json:"smtp_cert_pin"`
}

type AddGmailOAuthRequest struct {
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	SenderName   string `json:"sender_name"`
	AvatarURL    string `json:"avatar_url"`
	AuthCode     string `json:"auth_code"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

// AddOutlookOAuthRequest mirrors AddGmailOAuthRequest. AvatarURL is unused
// (Microsoft's id_token carries no picture) but kept for shape parity.
type AddOutlookOAuthRequest struct {
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	SenderName   string `json:"sender_name"`
	AvatarURL    string `json:"avatar_url"`
	AuthCode     string `json:"auth_code"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

type FolderListRequest struct {
	AccountID string `json:"account_id"`
	Refresh   bool   `json:"refresh"`
}

type FolderCreateRequest struct {
	AccountID string `json:"account_id"`
	Name      string `json:"name"`
}

type FolderDeleteRequest struct {
	AccountID string `json:"account_id"`
	FolderID  string `json:"folder_id"`
}

type ThreadListRequest struct {
	AccountID string `json:"account_id"`
	FolderID  string `json:"folder_id"`
	// Unified view only: the role each account answers from (its own Sent,
	// Archive, …). Ignored for a single account, which names a real folder.
	FolderRole string `json:"folder_role"`
	Query      string `json:"query"`
	Filter     string `json:"filter"`
	// Sort is `date`, `sender` or `subject`, optionally suffixed `:asc`.
	// Empty means newest first, which is what a mailbox means when nobody has
	// said otherwise.
	Sort         string `json:"sort"`
	BeforeCursor string `json:"before_cursor"`
	Refresh      bool   `json:"refresh"`
	Limit        uint32 `json:"limit,omitempty"`
}

func (r ThreadListRequest) pageLimit() uint32 {
	if r.Limit == 0 {
		return 50
	}
	return r.Limit
}

type AttachmentInput struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Data     string `json:"data"` // base64 encoded
	InlineID string `json:"inline_id"`
}

type SendMailRequest struct {
	AccountID   string            `json:"account_id"`
	To          string            `json:"to"`
	Cc          string            `json:"cc"`
	Bcc         string            `json:"bcc"`
	Subject     string            `json:"subject"`
	Body        string            `json:"body"`
	Html        string            `json:"html"`
	InReplyTo   string            `json:"in_reply_to"`
	References  string            `json:"references"`
	ReplyTo     string            `json:"reply_to"`
	From        string            `json:"from"`
	DraftID     string            `json:"draft_id"`
	MessageID   string            `json:"message_id"`
	Attachments []AttachmentInput `json:"attachments"`
	// Sign and Encrypt ask for OpenPGP protection. A request that cannot be
	// met fails the send: a message meant to be encrypted that went in the
	// clear is worse than one that did not go.
	Sign    bool `json:"sign,omitempty"`
	Encrypt bool `json:"encrypt,omitempty"`
	// Passphrase unlocks the sender's own key for this one message. Not
	// stored anywhere on this side, and not written to a draft.
	Passphrase string `json:"passphrase,omitempty"`
}

type ExchangedProfile struct {
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	AvatarURL    string `json:"avatar_url"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	AuthCode     string `json:"auth_code"`
}

type TokenExchangeResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	// IDToken is the OIDC id_token Microsoft returns; Google omits it. Used to
	// read the account email/name without an extra userinfo call.
	IDToken string `json:"id_token"`
}

type GoogleUserInfo struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Picture string `json:"picture"`
}

type ImapThreadIDs struct {
	Account   string
	Folder    string
	ThreadKey string
	UID       uint32
}

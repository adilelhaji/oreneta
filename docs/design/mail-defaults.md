# Conventional mail defaults (#84)

New profiles use the existing `table`, `compact` and `traditional` settings:
sortable sender/subject/date columns and full-width stacked messages. Newest and
unread messages expand; older read messages collapse. No new rendering mode,
message model, protocol or persistence mechanism is introduced.

Valid saved `list_view`, `list_density` and `conversation_layout` values override
these defaults independently, including cards/chat. Missing or invalid values
leave the current supported value unchanged; no bulk preference migration runs.
Profiles that never saved these preferences receive the new defaults.

Users with saved cards/chat preferences adopt the experience in Settings > General:
Conversation layout = Traditional; List view = Table; List density = Compact.
The same controls restore Chat, Cards or another density. This does not reset
theme, sorting, accounts, reading width, read-marking policy, drafts or signatures.
The table already has compact rows; density controls the alternative card list.

Verification uses the production entry with synthetic bridge responses, not the
reference page: both cobalt themes, inbox/open/reply draft/selection/navigation,
legacy settings restoration, explicit switches and reload. No external messages
are sent. Native/provider certification remains in the parity ledger; narrow
600px reader correction and complete columns/reader polish remain #85/#34/#35.

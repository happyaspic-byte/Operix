# NAS automatic deployment

The user authorized GitHub main changes to update the existing Operix NAS deployment automatically. Both existing CI jobs must pass before publication. Preserve Portainer stack 19, endpoint 3, its full environment, databases, attachment/security/scanner volumes, external proxy network, HTTPS service, and unrelated applications.

Publish the exact container image exercised by CI as an immutable GitHub release with a checksum manifest. Update a dedicated nas-deploy branch pointer after publication. A NAS sidecar polls that public manifest every 60 seconds, validates main and the fixed verification workflow, downloads and checks the image, takes a database backup, and updates only the existing OPERIX_IMAGE environment value. No incoming connection from GitHub and no GitHub credentials on the NAS are required. Keep Portainer credentials in a private file, never in Git, images, logs, or Actions.

A failed release is recorded and not retried automatically. Restore the previous image after a failed replacement; this is not a database rollback. Keep predeployment database backups and configuration snapshots for operator recovery. Store the running revision and bounded operational logs. Existing untracked files and old worktrees are preserved.

# Working principles

Agents wrote this code and agents change it. Treat every implementation as
mutable unless it is obviously core functionality. The current code is not
gospel: if a change does not fit the existing design, refactor the design
instead of bolting a workaround on top. When new code makes old code
redundant, delete the old code in the same change — deletion is as important
as addition.

See `docs/architecture.md` for the system design and `README.md` for usage.

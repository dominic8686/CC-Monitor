# CC-Monitor is pure Python with no build step; this Makefile only "installs it into the system":
# it copies the cc_monitor/ package, the bin/ scripts and install.py under PREFIX, then creates the
# command-line links in PREFIX/bin.
# Registering the hooks in Claude Code's settings.json is a separate matter (see the note printed by
# `make install`) and is not done automatically here: it changes the user's personal configuration
# file, so the user should run it explicitly.
PREFIX ?= /usr/local
LIBDIR := $(PREFIX)/lib/cc-monitor
BINDIR := $(PREFIX)/bin
PY ?= python3

.PHONY: install uninstall

install:
	install -d "$(LIBDIR)" "$(BINDIR)"
	cp -a cc_monitor "$(LIBDIR)/"
	cp -a bin "$(LIBDIR)/"
	cp -a install.py "$(LIBDIR)/"
	chmod +x "$(LIBDIR)"/bin/*
	ln -sf "$(LIBDIR)/bin/CC-Monitor" "$(BINDIR)/CC-Monitor"
	ln -sf "$(LIBDIR)/bin/CC-Monitor-hook" "$(BINDIR)/CC-Monitor-hook"
	ln -sf "$(LIBDIR)/bin/CC-Monitor-probe" "$(BINDIR)/CC-Monitor-probe"
	@echo ""
	@echo "Installed to $(LIBDIR); command-line tools linked into $(BINDIR) (CC-Monitor / CC-Monitor-hook / CC-Monitor-probe)."
	@echo ""
	@echo "One last step: register the hooks in Claude Code's settings.json (this is not done automatically):"
	@echo "  $(PY) $(LIBDIR)/install.py                          # global install: writes ~/.claude/settings.json"
	@echo "  $(PY) $(LIBDIR)/install.py --project /path/to/proj  # applies to one project only"

uninstall:
	rm -f "$(BINDIR)/CC-Monitor" "$(BINDIR)/CC-Monitor-hook" "$(BINDIR)/CC-Monitor-probe"
	rm -rf "$(LIBDIR)"
	@echo "Removed $(LIBDIR) and the command-line links in $(BINDIR)."
	@echo "Note: hook entries already registered in ~/.claude/settings.json are not cleaned up automatically; edit the file to remove them."

.PHONY: help build clean install test

help:
	@echo "ShipNode Build System"
	@echo ""
	@echo "Available targets:"
	@echo "  make build   - Build distributable installer"
	@echo "  make clean   - Remove dist directory"
	@echo "  make install - Install locally from source"
	@echo "  make test    - Test the installer"

build:
	@./build-dist.sh

clean:
	@echo "Cleaning dist directory..."
	@rm -rf dist/
	@echo "✓ Clean complete"

install:
	@echo "Installing ShipNode locally..."
	@./install.sh

test: build
	@echo "Testing installer..."
	@bash dist/shipnode-installer.sh

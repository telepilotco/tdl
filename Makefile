UNAME := $(shell uname)

LIB_FILE = addon.node

ifeq ($(UNAME), Darwin)
ARCH ?= $(shell uname -m)
LIBC ?= unknown
endif

ifeq ($(UNAME), Linux)
ARCH ?= $(shell uname -m)
LIBC ?= glibc
endif

ifeq ($(ARCH), x86_64)
ARCH = x64
endif

DOCKER_IMAGE_GLIBC = node:18-slim
DOCKER_IMAGE_MUSL = node:18-alpine

DOCKER_PLATFORM_ARM64 = arm64
DOCKER_PLATFORM_X64 = amd64

TGZ_NAME = $(shell uname | tr '[:upper:]' '[:lower:]')-$(ARCH)-$(LIBC).tar.gz

.ONESHELL:

init:
	pnpm install
ifeq ($(UNAME), Darwin)
	curl -sL https://github.com/nodejs/node-gyp/raw/main/macOS_Catalina_acid_test.sh | bash
	xcode-select --install
	brew install gperf openssl zlib #macos-only
endif
ifeq ($(UNAME), Linux)
#see https://tdlib.github.io/deps/td/build.html?language=JavaScript
	sudo apt-get update
	sudo apt-get install make git zlib1g-dev libssl-dev gperf php-cli cmake g++ -y
	sudo apt-get install npm docker.io -y
endif


clean: clean-prebuilds clean-archives

build:
	build-lib

run:
	bash run.sh

publish:
	npm publish

clean:
	rm -rf build/
	rm -rf dist/
	rm -rf node_modules/
	clean-prebuilds
	clean-archives

clean-prebuilds:
	rm -rf prebuilds/

clean-archives:
	rm -rf *.tar.gz
	rm -rf prebuilds/*.tar.gz

build-lib-native: build-lib-native-compile build-lib-archive

build-lib-docker-linux-arm64-glibc:
	mkdir -p prebuilds/linux-arm64
	docker run \
	 -v `pwd`:/rep \
	 -v `pwd`/prebuilds/linux-arm64:/result \
	 --platform linux/$(DOCKER_PLATFORM_ARM64) \
	 $(DOCKER_IMAGE_GLIBC) \
	 sh /rep/prebuilt-addon-docker.sh

build-lib-docker-linux-arm64-musl:
	mkdir -p prebuilds/linux-arm64
	docker run \
	 -v `pwd`:/rep \
	 -v `pwd`/prebuilds/linux-arm64:/result \
	 --platform linux/$(DOCKER_PLATFORM_ARM64) \
	 $(DOCKER_IMAGE_MUSL) \
	 sh /rep/prebuilt-addon-docker.sh

#build-lib-docker-linux-x64-glibc:
#	mkdir -p prebuilds/linux-x64
#	docker run \
#	 -v `pwd`:/rep \
#	 --platform linux/$(DOCKER_PLATFORM_X64) \
#	 $(DOCKER_IMAGE_GLIBC) \
#	 sh /rep/prebuilt-addon-docker.sh

build-lib-docker-linux-x64-musl:
	mkdir -p prebuilds/linux-x64
	docker run \
	 -v `pwd`:/rep \
	 	 -v `pwd`/prebuilds/linux-x64:/result \
	 --platform linux/$(DOCKER_PLATFORM_X64) \
	 $(DOCKER_IMAGE_MUSL) \
	 sh /rep/prebuilt-addon-docker.sh



build-lib-native-compile:
	npm run build:gyp
	mkdir -p prebuilds/lib/
	cp -L build/Release/$(LIB_FILE) ./prebuilds/lib/$(LIB_FILE)

build-lib-archive:
	cd prebuilds && tar -czvf $(TGZ_NAME) lib/* && cp $(TGZ_NAME) ..

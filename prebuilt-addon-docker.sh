if ! [ -x "$(command -v apk)" ]; then
  export TZ=Europe/Berlin
  ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
  apt-get update
  apt-get install -y -q \
    python3 make cmake gcc g++ git
else
  apk update
  apk --no-cache add \
    python3 make cmake gcc g++ git
fi

cd rep/
rm -rf node_modules/
npm install -g pnpm
pnpm install --ignore-scripts
ls -la node_modules
npm run make-prebuild -w @telepilotco/tdl -- --tag-libc


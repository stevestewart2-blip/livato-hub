FROM homeassistant/aarch64-base:latest

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install
COPY hub.js ./
COPY run.sh ./
RUN chmod +x run.sh

CMD ["/app/run.sh"]

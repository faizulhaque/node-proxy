FROM node:14-alpine
RUN apk add  --no-cache ffmpeg

RUN mkdir -p /app
WORKDIR /app
COPY package.json /app
RUN npm i
COPY . /app
EXPOSE 8088
CMD ["npm", "start"]

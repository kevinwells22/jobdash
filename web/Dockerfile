FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js index.html ./

EXPOSE 8080
CMD ["node", "server.js"]

FROM node:20-alpine

WORKDIR /app
COPY package.json .
RUN npm install

COPY src ./src

USER node

CMD ["node", "src/index.js"]

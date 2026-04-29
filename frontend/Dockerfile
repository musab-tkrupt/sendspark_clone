FROM node:20-alpine

WORKDIR /app

COPY voice/frontend/package.json voice/frontend/package-lock.json ./
RUN npm install

COPY voice/frontend ./

EXPOSE 3001

CMD ["npm", "run", "dev"]

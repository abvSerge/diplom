FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY autoscaler.js ./

EXPOSE 9100

CMD ["node", "autoscaler.js"]

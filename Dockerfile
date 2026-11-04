# Minimal Node.js image for the line simulation
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY rate_card.csv failure_rates.csv demand_profile.csv ./
EXPOSE 3000
CMD ["node", "src/server.js"]

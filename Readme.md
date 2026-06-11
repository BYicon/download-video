# development
`yarn start:dev`

# deploy
1. Execute `yarn build`.
2. Upload the dist to your server.
3. Execute `pm2 start npm --name "goat-fs" -- start`.

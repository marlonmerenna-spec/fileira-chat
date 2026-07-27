# Fileira — protótipo de rede social com salas de bate-papo e avatar 3D

## Como rodar

1. Instale o Node.js (18 ou superior) no seu PC, se ainda não tiver: https://nodejs.org
2. Abra o terminal dentro desta pasta e rode:

```bash
npm install
npm start
```

3. O terminal vai mostrar dois endereços:
   - `http://localhost:3000` → use no navegador do próprio PC
   - `http://SEU_IP_LOCAL:3000` → use no navegador do celular (o celular precisa estar
     na **mesma rede Wi-Fi** do PC)

## O que já funciona

- Criar perfil com nome
- Gerar avatar 3D a partir de uma foto (usa o criador gratuito de demonstração da
  Ready Player Me, que abre dentro do próprio site)
- Lobby com salas públicas (Geral, Games, Música, Desabafo)
- Criar sala privada (gera um código de convite) e entrar em sala privada pelo código
- Sala de bate-papo em tempo real com:
  - fileira de avatares 3D de quem está na sala (o "elemento boneco" estilo Orkut)
  - indicador de "fulano está digitando"
  - brilho ao redor do avatar de quem acabou de mandar mensagem
  - histórico das últimas mensagens da sala

## Limitações desta versão (é um protótipo)

- Os dados ficam só na memória do servidor — se você reiniciar o servidor,
  salas privadas e histórico de mensagens somem
- Não tem login/senha de verdade, é só um nome digitado
- O avatar usa o serviço de demonstração gratuito da Ready Player Me, que é ótimo
  pra testar mas tem um selo de "demo"; pra produção seria preciso criar uma conta
  própria (ainda gratuita até um certo volume de usuários)
- Sem feed de posts/curtidas ainda — isso fica pra próxima fase, depois que o
  núcleo do chat estiver validado

## Próximos passos sugeridos

1. Testar bastante o fluxo de chat + avatar com amigos
2. Adicionar um banco de dados leve (ex: SQLite) pra salas e histórico não sumirem
3. Adicionar o feed de posts (fase 2) reaproveitando o mesmo sistema de perfil/avatar
4. Pensar em moderação básica das salas públicas antes de abrir pro público

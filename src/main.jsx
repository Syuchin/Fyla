import { render } from 'preact'
import { IntlProvider } from 'preact-i18n'
import { definition } from './lib/i18n.js'
import { App } from './app.jsx'
import 'katex/dist/katex.min.css'
import './style.css'

function Root() {
  return (
    <IntlProvider definition={definition.value}>
      <App />
    </IntlProvider>
  )
}

render(<Root />, document.getElementById('app'))

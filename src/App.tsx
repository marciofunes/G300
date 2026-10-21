import { HashRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { VisaoGeral } from './screens/VisaoGeral';
import { Qualidade } from './screens/Qualidade';
import { Referencias } from './screens/Referencias';
import { Condicao } from './screens/Condicao';
import { Investigacao } from './screens/Investigacao';

export default function App() {
  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<VisaoGeral />} />
          <Route path="/qualidade" element={<Qualidade />} />
          <Route path="/referencias" element={<Referencias />} />
          <Route path="/condicao" element={<Condicao />} />
          <Route path="/investigacao" element={<Investigacao />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}

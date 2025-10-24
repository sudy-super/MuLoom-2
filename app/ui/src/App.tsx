import { Navigate, Route, Routes } from 'react-router-dom';
import ControlPage from './pages/ControlPage';
import ViewerPage from './pages/ViewerPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<ViewerPage />} />
      <Route path="/control" element={<ControlPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
